import type { PackageResult } from "../types.js";
import ora from "ora";
import { isRegistryCacheFresh, readRegistryCache, writeRegistryCache } from "../cache.js";

export interface NpmCheckInput {
  name: string;
  version: string;
}

export const KNOWN_REPLACEMENTS: Record<string, string> = {
  request: "got or node-fetch",
  "node-uuid": "uuid",
  jade: "pug",
  grunt: "vite or esbuild",
  bower: "npm workspaces",
  moment: "dayjs or date-fns",
  faker: "@faker-js/faker",
};

function chunk<T>(items: T[], size: number): T[][] {
  if (size <= 0) return [items];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function stripVersionPrefix(version: string): string {
  const v = version.trim();
  return v.replace(/^(?:\^|~|>=|>|<=|<|=|v)\s*/i, "");
}

function majorOf(version: string): number | null {
  const m = version.trim().match(/^(\d+)(?:\.\d+)?(?:\.\d+)?/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function extractReplacementFromDeprecation(message: string): string | undefined {
  const m = message.match(/use\s+(.+?)\s+instead/i);
  if (!m) return undefined;
  const candidate = m[1].trim();
  if (!candidate) return undefined;
  return candidate.replace(/[.,;:]$/, "");
}

export async function checkNpmPackage(input: NpmCheckInput): Promise<PackageResult> {
  const issues: string[] = [];
  const url = `https://registry.npmjs.org/${encodeURIComponent(input.name)}`;
  const cacheKey = input.name;

  const cached = readRegistryCache(cacheKey);
  if (cached && isRegistryCacheFresh(cached) && cached.url === url) {
    const res = new Response(cached.body, { status: cached.status });
    return await finalizeNpmResponse(input, res, issues);
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
      name: input.name,
      version: input.version,
      exists: true,
      deprecated: false,
      latestVersion: "",
      issues: ["Could not verify — registry unreachable"],
    };
  }

  return await finalizeNpmResponse(input, res, issues);
}

async function finalizeNpmResponse(
  input: NpmCheckInput,
  res: Response,
  issues: string[],
): Promise<PackageResult> {
  if (res.status === 404) {
    issues.push("Package not found on npm registry");
    const known = KNOWN_REPLACEMENTS[input.name];
    return {
      name: input.name,
      version: input.version,
      exists: false,
      deprecated: false,
      latestVersion: "",
      replacement: known,
      issues,
    };
  }

  if (res.status !== 200) {
    issues.push("Could not verify — registry unreachable");
    return {
      name: input.name,
      version: input.version,
      exists: true,
      deprecated: false,
      latestVersion: "",
      issues,
    };
  }

  type NpmPackument = {
    ["dist-tags"]?: { latest?: string };
    versions?: Record<string, { deprecated?: string }>;
  };

  let data: NpmPackument;
  try {
    data = (await res.json()) as NpmPackument;
  } catch {
    issues.push("Could not verify — registry unreachable");
    return {
      name: input.name,
      version: input.version,
      exists: true,
      deprecated: false,
      latestVersion: "",
      issues,
    };
  }

  const latestVersion = data["dist-tags"]?.latest ?? "";
  const deprecationMessage = latestVersion ? data.versions?.[latestVersion]?.deprecated : undefined;
  const deprecated = Boolean(deprecationMessage);
  const knownReplacement = KNOWN_REPLACEMENTS[input.name];
  const parsedReplacement = deprecationMessage ? extractReplacementFromDeprecation(deprecationMessage) : undefined;
  const replacement = knownReplacement ?? parsedReplacement;

  if (deprecated) {
    issues.push("Package is deprecated");
    if (deprecationMessage) issues.push(deprecationMessage);
  }

  const installedMajor = majorOf(input.version);
  const latestMajor = majorOf(latestVersion);
  if (installedMajor !== null && latestMajor !== null && latestMajor - installedMajor > 1) {
    issues.push(
      `Installed version (${input.version}) is more than one major behind latest (${latestVersion})`,
    );
  }

  return {
    name: input.name,
    version: input.version,
    exists: true,
    deprecated,
    latestVersion,
    replacement,
    issues,
  };
}

export async function checkAllNpmPackages(
  packages: Record<string, string>,
): Promise<PackageResult[]> {
  const entries = Object.entries(packages).map(([name, version]) => ({
    name,
    version: stripVersionPrefix(version),
  }));

  const spinner = ora("Checking npm packages...").start();
  const results: PackageResult[] = [];

  try {
    for (const batch of chunk(entries, 5)) {
      const batchResults = await Promise.all(
        batch.map(async (pkg) => {
          spinner.text = `Checking ${pkg.name}`;
          return await checkNpmPackage(pkg);
        }),
      );
      results.push(...batchResults);
    }

    spinner.succeed(`Checked ${entries.length} npm package(s)`);
    return results;
  } catch (err) {
    spinner.fail("Failed while checking npm packages");
    throw err;
  }
}

export const _internal = {
  chunk,
  stripVersionPrefix,
  majorOf,
  extractReplacementFromDeprecation,
};
