import { Command } from "commander";
import { existsSync, realpathSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { MethodResult, PackageResult, ScanReport } from "./types.js";
import { parsePackageJson } from "./parsers/packageJson.js";
import { parseRequirements } from "./parsers/requirements.js";
import { checkAllNpmPackages } from "./checkers/npm.js";
import { checkAllPypiPackages } from "./checkers/pypi.js";
import { scanDirectory } from "./checkers/methods.js";
import { printReport } from "./reporters/console.js";

function readVersionFromNearestPackageJson(): string | undefined {
  try {
    const here = fileURLToPath(import.meta.url);
    const distDir = resolve(here, "..");
    const pkgPath = resolve(distDir, "..", "package.json");
    const raw = readFileSync(pkgPath, "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed?.version === "string" ? parsed.version : undefined;
  } catch {
    return undefined;
  }
}

function printNoManifestHelp(targetDir: string): void {
  process.stderr.write(
    [
      `No supported dependency manifest found in "${targetDir}".`,
      "",
      "Supported files:",
      "- package.json (npm)",
      "- requirements.txt (python)",
      "- pyproject.toml (python; [project].dependencies)",
      "",
      "Tip: pass --methods to scan source files without a manifest, or use --path to point at a project root.",
      "",
    ].join("\n"),
  );
}

function printFixSuggestions(report: ScanReport): void {
  const npmInstalls = new Set<string>();
  const npmUninstalls = new Set<string>();
  const pipInstalls = new Set<string>();
  const pipUninstalls = new Set<string>();

  for (const p of report.packages) {
    const needsFix = (!p.exists && p.replacement) || (p.exists && p.deprecated && p.replacement);
    if (!needsFix) continue;

    const replacement = p.replacement;
    if (!replacement) continue;

    const isScopedNpm = p.name.startsWith("@") && p.name.includes("/");
    const looksLikeNpm = isScopedNpm || /^[A-Za-z0-9._-]+$/.test(p.name);

    if (looksLikeNpm) {
      npmUninstalls.add(p.name);
      for (const cand of replacement.split(/\s+or\s+/i).map((s) => s.trim()).filter(Boolean)) {
        const first = cand.split(/\s+/)[0]?.trim();
        if (first) npmInstalls.add(first);
      }
      continue;
    }

    pipUninstalls.add(p.name);
    for (const cand of replacement.split(/\s+or\s+/i).map((s) => s.trim()).filter(Boolean)) {
      const first = cand.split(/\s+/)[0]?.trim();
      if (first) pipInstalls.add(first);
    }
  }

  if (npmInstalls.size === 0 && npmUninstalls.size === 0 && pipInstalls.size === 0 && pipUninstalls.size === 0) {
    return;
  }

  process.stdout.write("\nSuggested commands (not executed):\n");
  if (npmUninstalls.size > 0 || npmInstalls.size > 0) {
    const uninstall = Array.from(npmUninstalls).sort().join(" ");
    const install = Array.from(npmInstalls).sort().join(" ");
    if (uninstall && install) process.stdout.write(`Run: npm install ${install} && npm uninstall ${uninstall}\n`);
    else if (install) process.stdout.write(`Run: npm install ${install}\n`);
    else if (uninstall) process.stdout.write(`Run: npm uninstall ${uninstall}\n`);
  }

  if (pipUninstalls.size > 0 || pipInstalls.size > 0) {
    const uninstall = Array.from(pipUninstalls).sort().join(" ");
    const install = Array.from(pipInstalls).sort().join(" ");
    if (uninstall && install) process.stdout.write(`Run: pip install ${install} && pip uninstall -y ${uninstall}\n`);
    else if (install) process.stdout.write(`Run: pip install ${install}\n`);
    else if (uninstall) process.stdout.write(`Run: pip uninstall -y ${uninstall}\n`);
  }
}

export interface CliOptions {
  cwd?: string;
  verbose?: boolean;
}

export async function runCli(_argv: string[] = process.argv): Promise<void> {
  const program = new Command();
  program.name("hallucination-guard").description("Detect hallucinated packages and method calls.");
  const v = readVersionFromNearestPackageJson();
  if (v) program.version(v);

  program
    .command("scan")
    .description("Scan the current project.")
    .option("--npm", "Only check npm packages", false)
    .option("--python", "Only check python packages", false)
    .option("--methods", "Only check method calls", false)
    .option("--fix", "Print suggested replacement commands (does not execute)", false)
    .option("--json", "Output raw JSON report", false)
    .option("--path <dir>", "Scan a different directory", ".")
    .action(
      async (opts: {
        npm: boolean;
        python: boolean;
        methods: boolean;
        fix: boolean;
        json: boolean;
        path: string;
      }) => {
      const targetDir = resolve(process.cwd(), opts.path);
      const originalCwd = process.cwd();
      process.chdir(targetDir);
      try {

      const pkgJsonPath = join(targetDir, "package.json");
      const reqTxtPath = join(targetDir, "requirements.txt");
      const pyprojectPath = join(targetDir, "pyproject.toml");

      const hasPkgJson = existsSync(pkgJsonPath);
      const hasReqTxt = existsSync(reqTxtPath);
      const hasPyproject = existsSync(pyprojectPath);
      const hasAnyManifest = hasPkgJson || hasReqTxt || hasPyproject;

      const hasNpmManifest = hasPkgJson;
      const hasPythonManifest = hasReqTxt || hasPyproject;

      const anyFlag = opts.npm || opts.python || opts.methods;

      const shouldNpm = (anyFlag ? opts.npm : hasNpmManifest) && hasNpmManifest;
      const shouldPython = (anyFlag ? opts.python : hasPythonManifest) && hasPythonManifest;
      const shouldMethods = anyFlag ? opts.methods : true;

      // Flags override auto-detection; missing-manifest errors should only apply
      // when the user explicitly asked for that ecosystem scan.
      const wantsNpm = anyFlag ? opts.npm : hasNpmManifest;
      const wantsPython = anyFlag ? opts.python : hasPythonManifest;
      const wantsPackageChecks = wantsNpm || wantsPython;

      if (!hasAnyManifest && wantsPackageChecks && !opts.methods) {
        printNoManifestHelp(targetDir);
        process.exitCode = 1;
        return;
      }

      if (opts.npm && !hasPkgJson && !opts.methods) {
        process.stderr.write(
          `No package.json found in "${targetDir}" (needed for --npm / default npm scan).\n`,
        );
        process.exitCode = 1;
        return;
      }

      if (opts.python && !hasReqTxt && !hasPyproject && !opts.methods) {
        process.stderr.write(
          `No requirements.txt or pyproject.toml found in "${targetDir}" (needed for --python / default python scan).\n`,
        );
        process.exitCode = 1;
        return;
      }

      const packagesToCheck: Array<Promise<PackageResult[]>> = [];
      const methodChecks: Array<Promise<MethodResult[]>> = [];

      if (shouldNpm) {
        const { dependencies, devDependencies } = parsePackageJson(pkgJsonPath);
        packagesToCheck.push(checkAllNpmPackages({ ...dependencies, ...devDependencies }));
      }

      if (shouldPython) {
        const pyPkgs = parseRequirements(hasReqTxt ? reqTxtPath : pyprojectPath);
        packagesToCheck.push(checkAllPypiPackages(pyPkgs));
      }

      if (shouldMethods) {
        const installedPackages: string[] = [];
        if (hasPkgJson) {
          const { dependencies, devDependencies } = parsePackageJson(pkgJsonPath);
          installedPackages.push(...Object.keys({ ...dependencies, ...devDependencies }));
        }
        methodChecks.push(scanDirectory(targetDir, installedPackages));
      }

      const [pkgResultsNested, methodResultsNested] = await Promise.all([
        Promise.all(packagesToCheck),
        Promise.all(methodChecks),
      ]);

      const packages = pkgResultsNested.flat();
      const methods = methodResultsNested.flat();

      const report: ScanReport = {
        packages,
        methods,
        summary: {
          total: packages.length + methods.length,
          hallucinated: packages.filter((p) => !p.exists).length,
          deprecated: packages.filter((p) => p.exists && p.deprecated).length,
          methodIssues: methods.filter((m) => !m.exists).length,
        },
      };

      if (opts.json) {
        process.stdout.write(JSON.stringify(report, null, 2) + "\n");
      } else {
        printReport(report);
      }

      if (opts.fix) {
        printFixSuggestions(report);
      }

      if (report.summary.hallucinated > 0) {
        process.exitCode = 1;
      }
      } finally {
        process.chdir(originalCwd);
      }
    },
    );

  await program.parseAsync(_argv);
}

export async function buildEmptyReport(): Promise<ScanReport> {
  throw new Error("Not implemented");
}

function isDirectlyExecuted(argv: string[]): boolean {
  const entry = argv[1];
  if (!entry) return false;
  try {
    const thisPath = realpathSync(fileURLToPath(import.meta.url));
    const entryPath = realpathSync(resolve(entry));
    return thisPath === entryPath;
  } catch {
    return false;
  }
}

if (isDirectlyExecuted(process.argv)) {
  void runCli();
}
