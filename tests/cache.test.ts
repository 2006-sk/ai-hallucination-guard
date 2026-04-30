import { vol, fs } from "memfs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async () => {
  const { fs: mem } = await import("memfs");
  return mem;
});
vi.mock("node:fs/promises", async () => {
  const { fs: mem } = await import("memfs");
  return mem.promises;
});

import {
  getRegistryCacheDir,
  isRegistryCacheFresh,
  readRegistryCache,
  registryCacheFilePathForPackage,
  REGISTRY_CACHE_TTL_MS,
  writeRegistryCache,
} from "../src/cache.js";

beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
});

afterAll(() => {
  vi.useRealTimers();
});

beforeEach(() => {
  vol.reset();
  vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));
  expect(fs).toBeDefined();
});

describe("cache", () => {
  it("set then get returns the stored value", () => {
    writeRegistryCache("react", { url: "https://registry.npmjs.org/react", status: 200, body: "{}" });
    const got = readRegistryCache("react");
    expect(got).not.toBeNull();
    expect(got!.url).toBe("https://registry.npmjs.org/react");
    expect(got!.status).toBe(200);
    expect(got!.body).toBe("{}");
    expect(typeof got!.savedAt).toBe("number");
  });

  it("get on unknown key returns null (no throw)", () => {
    expect(readRegistryCache("unknown-key-xyz")).toBeNull();
  });

  it("read entry is stale after 25 hours (isRegistryCacheFresh false)", () => {
    writeRegistryCache("expire-me", { url: "u", status: 200, body: "{}" });
    const entry = readRegistryCache("expire-me");
    expect(entry).not.toBeNull();
    vi.setSystemTime(new Date("2025-01-02T02:00:00Z"));
    expect(isRegistryCacheFresh(entry!)).toBe(false);
  });

  it("entry stays fresh after 23 hours (within TTL)", () => {
    writeRegistryCache("stay-fresh", { url: "u", status: 200, body: "{}" });
    const entry = readRegistryCache("stay-fresh");
    expect(entry).not.toBeNull();
    vi.setSystemTime(new Date(new Date("2025-01-01T00:00:00Z").getTime() + 23 * 60 * 60 * 1000));
    expect(isRegistryCacheFresh(entry!)).toBe(true);
  });

  it("npm: and pypi: keys are independent namespaces (distinct cache files)", () => {
    writeRegistryCache("npm:react", { url: "u1", status: 200, body: "a" });
    writeRegistryCache("pypi:requests", { url: "u2", status: 200, body: "b" });
    expect(readRegistryCache("npm:react")?.body).toBe("a");
    expect(readRegistryCache("pypi:requests")?.body).toBe("b");
  });

  it("corrupted cache file returns null (no throw)", () => {
    const p = registryCacheFilePathForPackage("corrupt");
    fs.mkdirSync(getRegistryCacheDir(), { recursive: true });
    fs.writeFileSync(p, "NOT_JSON{{{", "utf8");
    expect(readRegistryCache("corrupt")).toBeNull();
  });

  it("creates cache directory automatically if missing", () => {
    writeRegistryCache("mkdir-test", { url: "u", status: 200, body: "{}" });
    const dir = getRegistryCacheDir();
    expect(fs.readdirSync(dir).length).toBeGreaterThan(0);
  });
});
