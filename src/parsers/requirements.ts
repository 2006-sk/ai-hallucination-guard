import { readFileSync } from "node:fs";

export function parseRequirements(filePath: string): Record<string, string> {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Could not read requirements file at "${filePath}": ${msg}`);
  }

  if (filePath.toLowerCase().endsWith(".toml")) {
    return parsePyprojectTomlDependencies(raw);
  }

  return parseRequirementsTxt(raw);
}

function parseRequirementsTxt(contents: string): Record<string, string> {
  const out: Record<string, string> = {};

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("#")) continue;

    const lower = line.toLowerCase();
    if (
      lower.startsWith("-r ") ||
      lower.startsWith("-c ") ||
      lower.startsWith("--index-url") ||
      lower.startsWith("http://") ||
      lower.startsWith("https://")
    ) {
      continue;
    }

    const parsed = parseRequirementSpec(line);
    if (!parsed) continue;
    out[parsed.name] = parsed.version;
  }

  return out;
}

function parsePyprojectTomlDependencies(contents: string): Record<string, string> {
  // Minimal, dependency-free TOML parsing for:
  // [project]
  // dependencies = ["requests==2.28.0", "flask>=2.0"]
  const out: Record<string, string> = {};

  const lines = contents.split(/\r?\n/);
  let inProject = false;
  let collectingDeps = false;
  let depsBuffer = "";

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const section = line.match(/^\[(.+?)\]\s*$/);
    if (section) {
      const name = section[1]?.trim();
      inProject = name === "project";
      collectingDeps = false;
      depsBuffer = "";
      continue;
    }

    if (!inProject) continue;

    if (!collectingDeps) {
      const m = line.match(/^dependencies\s*=\s*(.+)$/);
      if (!m) continue;
      const rhs = m[1] ?? "";
      depsBuffer = rhs;
      collectingDeps = !rhs.includes("]");
    } else {
      depsBuffer += ` ${line}`;
      if (line.includes("]")) collectingDeps = false;
    }

    if (!collectingDeps && depsBuffer) {
      for (const dep of extractTomlStringArrayItems(depsBuffer)) {
        const parsed = parseRequirementSpec(dep);
        if (!parsed) continue;
        out[parsed.name] = parsed.version;
      }
      depsBuffer = "";
    }
  }

  return out;
}

function extractTomlStringArrayItems(arrayExpr: string): string[] {
  const items: string[] = [];
  const re = /"([^"]+)"|'([^']+)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(arrayExpr))) {
    items.push((m[1] ?? m[2] ?? "").trim());
  }
  return items;
}

function parseRequirementSpec(spec: string): { name: string; version: string } | null {
  // Remove inline comments.
  const cleaned = spec.split("#")[0]?.trim() ?? "";
  if (!cleaned) return null;

  // Drop environment markers: pkg; python_version < "3.11"
  const beforeMarker = cleaned.split(";")[0]?.trim() ?? "";
  if (!beforeMarker) return null;

  // Strip extras: package[extra]==1.0  -> package==1.0
  const noExtras = beforeMarker.replace(/\[.*?\]/g, "");

  // Extract name and optional operator+version
  const m = noExtras.match(
    /^([A-Za-z0-9._-]+)\s*(?:(==|~=|!=|>=|<=|>|<|=)\s*([^\s]+))?\s*$/,
  );
  if (!m) return null;

  const name = m[1] ?? "";
  const op = m[2] ?? "";
  const ver = m[3] ?? "";

  if (!name) return null;
  if (op === "==" && ver) return { name, version: ver };
  if (op && ver) return { name, version: `${op}${ver}` };
  return { name, version: "" };
}
