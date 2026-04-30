import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const REGISTRY_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export type RegistryCacheEntry = {
  savedAt: number;
  url: string;
  status: number;
  body: string;
};

export function getRegistryCacheDir(): string {
  return join(homedir(), ".hallucination-guard-cache");
}

export function registryCacheFilePathForPackage(packageName: string): string {
  const safe = packageName.replace(/[^a-zA-Z0-9._-]+/g, "_");
  return join(getRegistryCacheDir(), `${safe}.json`);
}

export function readRegistryCache(packageName: string): RegistryCacheEntry | null {
  const filePath = registryCacheFilePathForPackage(packageName);
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as RegistryCacheEntry;
    if (!parsed || typeof parsed !== "object") return null;
    if (typeof parsed.savedAt !== "number") return null;
    if (typeof parsed.status !== "number") return null;
    if (typeof parsed.body !== "string") return null;
    if (typeof parsed.url !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeRegistryCache(packageName: string, entry: Omit<RegistryCacheEntry, "savedAt">): void {
  const dir = getRegistryCacheDir();
  mkdirSync(dir, { recursive: true });

  const full: RegistryCacheEntry = { ...entry, savedAt: Date.now() };
  const filePath = registryCacheFilePathForPackage(packageName);
  writeFileSync(filePath, JSON.stringify(full), "utf8");
}

export function isRegistryCacheFresh(entry: RegistryCacheEntry): boolean {
  return Date.now() - entry.savedAt < REGISTRY_CACHE_TTL_MS;
}
