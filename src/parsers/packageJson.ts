import { readFileSync } from "node:fs";

export function parsePackageJson(filePath: string): {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
} {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Could not read package.json at "${filePath}": ${msg}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid JSON in package.json at "${filePath}": ${msg}`);
  }

  if (parsed === null || typeof parsed !== "object") {
    throw new Error(`Invalid package.json at "${filePath}": root must be an object`);
  }

  const obj = parsed as Record<string, unknown>;
  const deps = obj.dependencies;
  const devDeps = obj.devDependencies;

  return {
    dependencies: isStringRecord(deps) ? deps : {},
    devDependencies: isStringRecord(devDeps) ? devDeps : {},
  };
}

function isStringRecord(v: unknown): v is Record<string, string> {
  if (v === null || typeof v !== "object") return false;
  for (const val of Object.values(v as Record<string, unknown>)) {
    if (typeof val !== "string") return false;
  }
  return true;
}
