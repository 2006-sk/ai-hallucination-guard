import { vol, fs } from "memfs";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async () => {
  const { fs: mem } = await import("memfs");
  return mem;
});
vi.mock("node:fs/promises", async () => {
  const { fs: mem } = await import("memfs");
  return mem.promises;
});

import { parsePackageJson } from "../../src/parsers/packageJson.js";

beforeEach(() => {
  vol.reset();
  expect(typeof fs.readFileSync).toBe("function");
});

describe("parsePackageJson", () => {
  it("parses dependencies + devDependencies from valid file", () => {
    vol.fromJSON(
      {
        "/proj/package.json": JSON.stringify({
          dependencies: { react: "^18.0.0" },
          devDependencies: { typescript: "^5.0.0" },
        }),
      },
      "/",
    );

    expect(parsePackageJson("/proj/package.json")).toEqual({
      dependencies: { react: "^18.0.0" },
      devDependencies: { typescript: "^5.0.0" },
    });
  });

  it("returns empty objects when both sections are absent", () => {
    vol.fromJSON({ "/proj/package.json": JSON.stringify({ name: "x" }) }, "/");

    expect(parsePackageJson("/proj/package.json")).toEqual({
      dependencies: {},
      devDependencies: {},
    });
  });

  it("does not throw when only dependencies exists (no devDependencies)", () => {
    vol.fromJSON(
      {
        "/proj/package.json": JSON.stringify({
          dependencies: { lodash: "^4.0.0" },
        }),
      },
      "/",
    );

    expect(parsePackageJson("/proj/package.json")).toEqual({
      dependencies: { lodash: "^4.0.0" },
      devDependencies: {},
    });
  });

  it("throws containing the file path when file does not exist", () => {
    expect(() => parsePackageJson("/proj/missing-package.json")).toThrow(/\/proj\/missing-package\.json/);
  });

  it("throws when JSON is invalid", () => {
    vol.fromJSON({ "/proj/package.json": "{ not json" }, "/");

    expect(() => parsePackageJson("/proj/package.json")).toThrow(/\/proj\/package\.json/);
  });

  it("preserves scoped package names (@types/node, @babel/core)", () => {
    vol.fromJSON(
      {
        "/proj/package.json": JSON.stringify({
          dependencies: { "@types/node": "^22.0.0", "@babel/core": "^7.0.0" },
        }),
      },
      "/",
    );

    expect(parsePackageJson("/proj/package.json").dependencies).toEqual({
      "@types/node": "^22.0.0",
      "@babel/core": "^7.0.0",
    });
  });

  it("handles empty string version without throwing", () => {
    vol.fromJSON(
      {
        "/proj/package.json": JSON.stringify({
          dependencies: { emptyver: "" },
        }),
      },
      "/",
    );

    expect(parsePackageJson("/proj/package.json").dependencies).toEqual({ emptyver: "" });
  });

  it("handles 100 dependencies — build the object programmatically", () => {
    const deps = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`pkg${i}`, `${i}.0.0`]));
    vol.fromJSON({ "/proj/package.json": JSON.stringify({ dependencies: deps }) }, "/");

    const result = parsePackageJson("/proj/package.json");
    expect(Object.keys(result.dependencies)).toHaveLength(100);
    expect(result.dependencies.pkg0).toBe("0.0.0");
    expect(result.dependencies.pkg99).toBe("99.0.0");
  });
});
