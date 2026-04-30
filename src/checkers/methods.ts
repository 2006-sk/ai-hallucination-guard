import type { MethodResult } from "../types.js";
import { createRequire } from "node:module";
import { readFile, readdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";

export interface MethodCheckInput {
  rootDir: string;
  installedPackages?: string[];
}

const exportsCache = new Map<string, string[]>();

export async function getPackageExports(packageName: string): Promise<string[]> {
  if (exportsCache.has(packageName)) return exportsCache.get(packageName)!;

  const pkgRoot = resolve(process.cwd(), "node_modules", packageName);
  const pkgJsonPath = join(pkgRoot, "package.json");

  let pkgJsonRaw: string;
  try {
    pkgJsonRaw = readFileSync(pkgJsonPath, "utf8");
  } catch {
    exportsCache.set(packageName, []);
    return [];
  }

  type PkgJson = {
    main?: string;
    exports?: unknown;
    types?: string;
    typings?: string;
  };

  let pkgJson: PkgJson;
  try {
    pkgJson = JSON.parse(pkgJsonRaw) as PkgJson;
  } catch {
    exportsCache.set(packageName, []);
    return [];
  }

  const typesRel =
    pkgJson.types ??
    pkgJson.typings ??
    findTypesInExports(pkgJson.exports) ??
    (typeof pkgJson.main === "string" && pkgJson.main.endsWith(".d.ts") ? pkgJson.main : undefined);

  if (typesRel) {
    const typesPath = resolve(pkgRoot, typesRel);
    try {
      const dts = await readFile(typesPath, "utf8");
      const names = extractExportedNamesFromTypes(dts);
      exportsCache.set(packageName, names);
      return names;
    } catch {
      // Fall through to runtime inspection.
    }
  }

  const require = createRequire(import.meta.url);
  try {
    const mod = require(packageName) as unknown;
    if (mod && typeof mod === "object") {
      const names = Object.keys(mod as Record<string, unknown>);
      exportsCache.set(packageName, names);
      return names;
    }
  } catch {
    // ignore, try ESM dynamic import next
  }

  try {
    const mod = (await import(packageName)) as unknown;
    if (mod && typeof mod === "object") {
      const names = Object.keys(mod as Record<string, unknown>);
      exportsCache.set(packageName, names);
      return names;
    }
  } catch {
    // ignore
  }

  exportsCache.set(packageName, []);
  return [];
}

export async function scanFileForMethodCalls(
  filePath: string,
  installedPackages: string[],
): Promise<MethodResult[]> {
  let contents: string;
  try {
    contents = await readFile(filePath, "utf8");
  } catch (err) {
    console.warn(`Skipping unreadable file: ${filePath}`, err);
    return [];
  }

  const results: MethodResult[] = [];
  const installed = new Set(installedPackages);

  // import { foo, bar as baz } from "pkg"
  const namedImportRe = /import\s*\{\s*([^}]+)\s*\}\s*from\s*['"]([^'"]+)['"]/g;
  // import * as pkg from "pkg-name"
  const namespaceImportRe = /import\s+\*\s+as\s+(\w+)\s+from\s*['"]([^'"]+)['"]/g;

  const namespaceVarToPkg = new Map<string, string>();
  const importChecks: Array<{ packageName: string; importedName: string; index: number }> = [];

  try {
    for (const m of contents.matchAll(namedImportRe)) {
      const list = (m[1] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      const packageName = m[2] ?? "";
      const baseIndex = m.index ?? 0;

      for (const item of list) {
        const importedName = item.split(/\s+as\s+/i)[0]?.trim() ?? "";
        if (!importedName) continue;
        importChecks.push({ packageName, importedName, index: baseIndex });
      }
    }

    for (const m of contents.matchAll(namespaceImportRe)) {
      const local = m[1] ?? "";
      const packageName = m[2] ?? "";
      if (local && packageName) namespaceVarToPkg.set(local, packageName);
    }
  } catch (err) {
    console.warn(`Skipping file due to parse error: ${filePath}`, err);
    return [];
  }

  const exportsByPkg = new Map<string, string[]>();
  for (const { packageName } of importChecks) {
    if (installed.size > 0 && !installed.has(packageName)) continue;
    if (!exportsByPkg.has(packageName)) exportsByPkg.set(packageName, await getPackageExports(packageName));
  }
  for (const [, packageName] of namespaceVarToPkg) {
    if (installed.size > 0 && !installed.has(packageName)) continue;
    if (!exportsByPkg.has(packageName)) exportsByPkg.set(packageName, await getPackageExports(packageName));
  }

  // Verify named imports exist in exports.
  for (const check of importChecks) {
    if (installed.size > 0 && !installed.has(check.packageName)) continue;
    const exps = exportsByPkg.get(check.packageName) ?? [];
    if (exps.length === 0) continue; // Skip if not installed or no signal.

    if (!exps.includes(check.importedName)) {
      results.push({
        file: filePath,
        line: lineNumberAtIndex(contents, check.index),
        packageName: check.packageName,
        method: check.importedName,
        exists: false,
      });
    }
  }

  // Verify namespace usage: pkg.someMethod(...)
  for (const [local, packageName] of namespaceVarToPkg) {
    if (installed.size > 0 && !installed.has(packageName)) continue;
    const exps = exportsByPkg.get(packageName) ?? [];
    if (exps.length === 0) continue;

    const callRe = new RegExp(String.raw`\b${escapeRegExp(local)}\.(\w+)\s*\(`, "g");
    for (const m of contents.matchAll(callRe)) {
      const method = m[1] ?? "";
      if (!method) continue;
      if (!exps.includes(method)) {
        results.push({
          file: filePath,
          line: lineNumberAtIndex(contents, m.index ?? 0),
          packageName,
          method,
          exists: false,
        });
      }
    }
  }

  // Known hallucinations for destructured usage: const { softDelete } = prisma
  const knownHallucinations: Record<string, string[]> = {
    prisma: ["softDelete", "upsertMany"],
    mongoose: ["bulkSave"],
  };

  const destructureRe = /const\s*\{\s*([^}]+)\s*\}\s*=\s*(\w+)/g;
  for (const m of contents.matchAll(destructureRe)) {
    const namesRaw = m[1] ?? "";
    const rhsIdent = m[2] ?? "";
    const packageName = namespaceVarToPkg.get(rhsIdent);
    if (!packageName) continue;

    const hallucinated = knownHallucinations[rhsIdent] ?? knownHallucinations[packageName];
    if (!hallucinated || hallucinated.length === 0) continue;

    const names = namesRaw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => s.split(":")[0]?.trim() ?? "");

    for (const method of names) {
      if (hallucinated.includes(method)) {
        results.push({
          file: filePath,
          line: lineNumberAtIndex(contents, m.index ?? 0),
          packageName,
          method,
          exists: false,
          suggestion: "Verify against official docs; this is a commonly hallucinated method.",
        });
      }
    }
  }

  return results;
}

export async function scanDirectory(dir: string, packages: string[]): Promise<MethodResult[]> {
  const results: MethodResult[] = [];
  const skipDirs = new Set(["node_modules", "dist", ".git", "build"]);
  const exts = new Set([".ts", ".tsx", ".js", ".jsx"]);

  async function walk(current: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (err) {
      console.warn(`Skipping unreadable directory: ${current}`, err);
      return;
    }

    await Promise.all(
      entries.map(async (ent) => {
        const full = join(current, ent.name);
        if (ent.isDirectory()) {
          if (skipDirs.has(ent.name)) return;
          await walk(full);
          return;
        }
        if (!ent.isFile()) return;
        if (!exts.has(extname(ent.name))) return;

        const fileResults = await scanFileForMethodCalls(full, packages);
        results.push(...fileResults);
      }),
    );
  }

  await walk(dir);
  return results;
}

export async function checkMethodCalls(input: MethodCheckInput): Promise<MethodResult[]> {
  return await scanDirectory(input.rootDir, input.installedPackages ?? []);
}

function extractExportedNamesFromTypes(dts: string): string[] {
  const names = new Set<string>();
  const re = /export\s+(?:declare\s+)?(?:function|const|class|type|interface)\s+(\w+)/g;
  for (const m of dts.matchAll(re)) {
    const name = m[1];
    if (name) names.add(name);
  }
  return Array.from(names);
}

function findTypesInExports(exportsField: unknown): string | undefined {
  if (!exportsField) return undefined;
  if (typeof exportsField === "string") return exportsField.endsWith(".d.ts") ? exportsField : undefined;
  if (typeof exportsField !== "object") return undefined;

  const visit = (node: unknown): string | undefined => {
    if (!node) return undefined;
    if (typeof node === "string") return node.endsWith(".d.ts") ? node : undefined;
    if (typeof node !== "object") return undefined;
    const obj = node as Record<string, unknown>;
    if (typeof obj.types === "string") return obj.types;
    for (const v of Object.values(obj)) {
      const found = visit(v);
      if (found) return found;
    }
    return undefined;
  };

  return visit(exportsField);
}

function lineNumberAtIndex(contents: string, index: number): number {
  if (index <= 0) return 1;
  let line = 1;
  for (let i = 0; i < contents.length && i < index; i++) {
    if (contents.charCodeAt(i) === 10) line++;
  }
  return line;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
