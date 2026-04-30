import { fs as memfsFs, vol } from "memfs";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async () => {
  const { fs } = await import("memfs");
  return fs;
});

import { checkAllNpmPackages, checkNpmPackage } from "../../src/checkers/npm.js";
import {
  mockFetch,
  mockFetchError,
  NPM_DEPRECATED_RESPONSE,
  NPM_REACT_RESPONSE,
} from "../setup.js";

beforeEach(() => {
  vol.reset();
});

describe("checkNpmPackage", () => {
  it("returns exists: true for a real package", async () => {
    mockFetch({
      "registry.npmjs.org/react": { status: 200, body: NPM_REACT_RESPONSE },
    });

    const result = await checkNpmPackage({ name: "react", version: "18.2.0" });

    expect(result.exists).toBe(true);
    expect(result.name).toBe("react");
    expect(result.latestVersion).toBe("18.2.0");
    expect(result.deprecated).toBe(false);
    expect(result.issues.length).toBe(0);
  });

  it("returns exists: false for a hallucinated package", async () => {
    mockFetch({
      "registry.npmjs.org/fake-axios-wrapper-xyz": { status: 404, body: {} },
    });

    const result = await checkNpmPackage({ name: "fake-axios-wrapper-xyz", version: "1.0.0" });

    expect(result.exists).toBe(false);
    expect(result.issues.some((i) => /not found|registry/i.test(i))).toBe(true);
  });

  it("detects deprecated package and extracts replacement", async () => {
    mockFetch({
      "registry.npmjs.org/request": { status: 200, body: NPM_DEPRECATED_RESPONSE },
    });

    const result = await checkNpmPackage({ name: "request", version: "2.88.0" });

    expect(result.deprecated).toBe(true);
    expect(result.replacement).toBeTruthy();
    expect(/got|node-fetch/i.test(result.replacement!)).toBe(true);
    expect(result.issues.length).toBeGreaterThan(0);
  });

  it("uses KNOWN_REPLACEMENTS map before parsing deprecation message", async () => {
    mockFetch({
      "registry.npmjs.org/moment": {
        status: 200,
        body: {
          "dist-tags": { latest: "2.30.1" },
          versions: {
            "2.30.1": {
              version: "2.30.1",
              deprecated: "this package is deprecated",
            },
          },
        },
      },
    });

    const result = await checkNpmPackage({ name: "moment", version: "2.30.1" });

    expect(result.replacement).toBeTruthy();
    expect(/dayjs|date-fns/i.test(result.replacement!)).toBe(true);
  });

  it("flags package as outdated when major version is behind", async () => {
    mockFetch({
      "registry.npmjs.org/somepackage": {
        status: 200,
        body: {
          "dist-tags": { latest: "4.0.0" },
          versions: { "4.0.0": { version: "4.0.0" } },
        },
      },
    });

    const result = await checkNpmPackage({ name: "somepackage", version: "2.0.0" });

    expect(
      result.issues.some(
        (i) =>
          /major|behind|newer|outdated|installed/i.test(i) &&
          /4\.0\.0/.test(i),
      ),
    ).toBe(true);
  });

  it("does NOT flag package as outdated for minor version difference", async () => {
    mockFetch({
      "registry.npmjs.org/react": {
        status: 200,
        body: {
          "dist-tags": { latest: "18.3.0" },
          versions: {
            "18.3.0": { version: "18.3.0" },
          },
        },
      },
    });

    const result = await checkNpmPackage({ name: "react", version: "18.2.0" });

    expect(result.issues.length).toBe(0);
  });

  it("handles network error gracefully without throwing", async () => {
    mockFetchError();

    const result = await checkNpmPackage({ name: "react", version: "18.0.0" });

    expect(result.exists).toBe(true);
    expect(result.issues.some((i) => i.includes("Could not verify"))).toBe(true);
  });

  it("handles malformed registry response gracefully", async () => {
    mockFetch({
      "registry.npmjs.org/react": { status: 200, body: {} },
    });

    const result = await checkNpmPackage({ name: "react", version: "18.0.0" });

    expect(result.exists).toBe(true);
  });

  it("handles non-200 registry status without throwing", async () => {
    mockFetch({
      "registry.npmjs.org/down": { status: 503, body: {} },
    });

    const result = await checkNpmPackage({ name: "down", version: "1.0.0" });

    expect(result.exists).toBe(true);
    expect(result.issues.some((i) => i.includes("Could not verify"))).toBe(true);
  });

  it("handles invalid JSON on 200 response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not-valid-json{{{", { status: 200, headers: { "content-type": "application/json" } })),
    );

    const result = await checkNpmPackage({ name: "bad-json", version: "1.0.0" });

    expect(result.exists).toBe(true);
    expect(result.issues.some((i) => i.includes("Could not verify"))).toBe(true);
  });

  it("ignores registry cache write failures", async () => {
    mockFetch({
      "registry.npmjs.org/cache-write-fail": {
        status: 200,
        body: { "dist-tags": { latest: "1.0.0" }, versions: { "1.0.0": { version: "1.0.0" } } },
      },
    });

    const spy = vi.spyOn(memfsFs, "writeFileSync").mockImplementationOnce(() => {
      throw new Error("write failed");
    });

    const result = await checkNpmPackage({ name: "cache-write-fail", version: "1.0.0" });

    spy.mockRestore();
    expect(result.exists).toBe(true);
    expect(result.latestVersion).toBe("1.0.0");
  });

  it("strips version prefix characters before comparing", async () => {
    mockFetch({
      "registry.npmjs.org/react": { status: 200, body: NPM_REACT_RESPONSE },
    });

    for (const version of ["^18.2.0", "~18.2.0", ">=18.0.0"] as const) {
      await expect(checkNpmPackage({ name: "react", version })).resolves.toMatchObject({
        exists: true,
        name: "react",
      });
    }
  });
});

describe("checkAllNpmPackages", () => {
  it("processes multiple packages and returns array", async () => {
    mockFetch({
      "registry.npmjs.org/react": { status: 200, body: NPM_REACT_RESPONSE },
      "registry.npmjs.org/lodash": {
        status: 200,
        body: {
          "dist-tags": { latest: "4.17.21" },
          versions: { "4.17.21": { version: "4.17.21" } },
        },
      },
      "registry.npmjs.org/fake-pkg": { status: 404, body: {} },
    });

    const results = await checkAllNpmPackages({
      react: "^18.0.0",
      lodash: "4.17.21",
      "fake-pkg": "1.0.0",
    });

    expect(results).toHaveLength(3);
    expect(results.find((r) => r.name === "fake-pkg")?.exists).toBe(false);
    expect(results.find((r) => r.name === "react")?.exists).toBe(true);
    expect(results.find((r) => r.name === "lodash")?.exists).toBe(true);
  });

  it("respects rate limiting — does not fire all requests simultaneously", async () => {
    let active = 0;
    let maxActive = 0;

    const minimal = {
      "dist-tags": { latest: "1.0.0" },
      versions: { "1.0.0": { version: "1.0.0" } },
    };

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 15));
        active -= 1;
        return new Response(JSON.stringify(minimal), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );

    const pkgs: Record<string, string> = {};
    for (let i = 0; i < 12; i++) pkgs[`rate-pkg-${i}`] = "1.0.0";

    await checkAllNpmPackages(pkgs);

    expect(maxActive).toBeLessThanOrEqual(5);
  });

  it("calls spinner.fail and rethrows when succeed throws", async () => {
    vi.doMock("ora", () => ({
      default: vi.fn(() => {
        const spinner = {
          start() {
            return spinner;
          },
          succeed() {
            throw new Error("succeed-throw");
          },
          fail: vi.fn(),
          text: "",
        };
        return spinner;
      }),
    }));

    vi.resetModules();
    const { checkAllNpmPackages: checkAll } = await import("../../src/checkers/npm.js");

    mockFetch({
      "registry.npmjs.org/z": { status: 200, body: NPM_REACT_RESPONSE },
    });

    await expect(checkAll({ z: "1.0.0" })).rejects.toThrow("succeed-throw");
  });

  it.skip("skips devDependencies when --no-dev flag is set", () => {
    // TODO: implement --no-dev on the CLI / checker and assert devDependencies are not scanned.
  });
});
