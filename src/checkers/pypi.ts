import type { PackageResult } from "../types.js";
import { isRegistryCacheFresh, readRegistryCache, writeRegistryCache } from "../cache.js";

function chunk<T>(items: T[], size: number): T[][] {
  if (size <= 0) return [items];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function normalizePypiName(name: string): string {
  return name.trim().toLowerCase().replaceAll("_", "-");
}

function stripRequirementOperator(version: string): string {
  const v = version.trim();
  return v.replace(/^(?:==|~=|!=|>=|<=|>|<|=)\s*/i, "");
}

function majorOf(version: string): number | null {
  const m = version.trim().match(/^(\d+)(?:\.\d+)?(?:\.\d+)?/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function extractReplacement(message: string): string | undefined {
  const m = message.match(/use\s+(.+?)\s+instead/i);
  if (!m) return undefined;
  const candidate = m[1].trim();
  if (!candidate) return undefined;
  return candidate.replace(/[.,;:]$/, "");
}

export async function checkPypiPackage(name: string, version: string): Promise<PackageResult> {
  const issues: string[] = [];
  const normalizedName = normalizePypiName(name);
  const url = `https://pypi.org/pypi/${encodeURIComponent(normalizedName)}/json`;
  const cacheKey = normalizedName;

  const cached = readRegistryCache(cacheKey);
  if (cached && isRegistryCacheFresh(cached) && cached.url === url) {
    const res = new Response(cached.body, { status: cached.status });
    return await finalizePypiResponse(name, version, res, issues);
  }

  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        accept: "application/json",
        "user-agent": "ai-hallucination-guard",
      },
    });
    try {
      const body = await res.clone().text();
      writeRegistryCache(cacheKey, { url, status: res.status, body });
    } catch {
      // ignore cache write failures
    }
  } catch {
    return {
      name,
      version,
      exists: true,
      deprecated: false,
      latestVersion: "",
      issues: ["Could not verify — registry unreachable"],
    };
  }

  return await finalizePypiResponse(name, version, res, issues);
}

async function finalizePypiResponse(
  name: string,
  version: string,
  res: Response,
  issues: string[],
): Promise<PackageResult> {
  if (res.status === 404) {
    issues.push("Package not found on PyPI");
    return {
      name,
      version,
      exists: false,
      deprecated: false,
      latestVersion: "",
      issues,
    };
  }

  if (res.status !== 200) {
    issues.push("Could not verify — registry unreachable");
    return {
      name,
      version,
      exists: true,
      deprecated: false,
      latestVersion: "",
      issues,
    };
  }

  type PypiJson = {
    info?: {
      name?: string;
      version?: string;
      summary?: string;
      requires_python?: string;
      yanked?: boolean;
      yanked_reason?: string;
    };
    releases?: Record<string, unknown>;
  };

  let data: PypiJson;
  try {
    data = (await res.json()) as PypiJson;
  } catch {
    issues.push("Could not verify — registry unreachable");
    return {
      name,
      version,
      exists: true,
      deprecated: false,
      latestVersion: "",
      issues,
    };
  }

  const latestVersion = data.info?.version ?? "";
  const yanked = data.info?.yanked === true;
  const yankedReason = data.info?.yanked_reason;
  const deprecated = yanked;
  const replacement = yankedReason ? extractReplacement(yankedReason) : undefined;

  if (deprecated) {
    issues.push("Package is yanked");
    if (yankedReason) issues.push(yankedReason);
  }

  const installedMajor = majorOf(version);
  const latestMajor = majorOf(latestVersion);
  if (installedMajor !== null && latestMajor !== null && latestMajor - installedMajor > 1) {
    issues.push(
      `Installed version (${version}) is more than one major behind latest (${latestVersion})`,
    );
  }

  return {
    name,
    version,
    exists: true,
    deprecated,
    latestVersion,
    replacement,
    issues,
  };
}

export async function checkAllPypiPackages(
  packages: Record<string, string>,
): Promise<PackageResult[]> {
  const entries = Object.entries(packages).map(([name, version]) => ({
    name,
    version: stripRequirementOperator(version),
  }));

  const results: PackageResult[] = [];
  for (const batch of chunk(entries, 5)) {
    const batchResults = await Promise.all(
      batch.map(async (p) => await checkPypiPackage(p.name, p.version)),
    );
    results.push(...batchResults);
  }
  return results;
}

export const _internal = {
  chunk,
  normalizePypiName,
  stripRequirementOperator,
  majorOf,
  extractReplacement,
};
