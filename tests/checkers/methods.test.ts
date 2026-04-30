import { vol, fs } from "memfs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async () => {
  const { fs: mem } = await import("memfs");
  return mem;
});
vi.mock("node:fs/promises", async () => {
  const { fs: mem } = await import("memfs");
  return mem.promises;
});

import { getPackageExports, scanDirectory, scanFileForMethodCalls } from "../../src/checkers/methods.js";

/** Virtual project root (memfs-only). Real `process.chdir` cannot enter this path. */
const WS = "/virtual-ws";

beforeEach(() => {
  vol.reset();
  vol.fromJSON({ [`${WS}/.keep`]: "" }, "/");
  vi.spyOn(process, "cwd").mockReturnValue(WS);
  expect(typeof fs.mkdirSync).toBe("function");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("getPackageExports", () => {
  it("reads exports from .d.ts pointed to by package.json types field", async () => {
    vol.fromJSON(
      {
        [`${WS}/node_modules/pkg-dts-one/package.json`]: JSON.stringify({
          name: "pkg-dts-one",
          version: "1.0.0",
          types: "index.d.ts",
        }),
        [`${WS}/node_modules/pkg-dts-one/index.d.ts`]:
          "export declare function findMany(): void;\nexport declare const x: number;\n",
      },
      "/",
    );

    const names = await getPackageExports("pkg-dts-one");
    expect(names).toContain("findMany");
    expect(names).toContain("x");
  });

  it("returns [] when package has no types field (no throw)", async () => {
    vol.fromJSON(
      {
        [`${WS}/node_modules/pkg-no-types/package.json`]: JSON.stringify({
          name: "pkg-no-types",
          version: "1.0.0",
        }),
      },
      "/",
    );

    await expect(getPackageExports("pkg-no-types")).resolves.toEqual([]);
  });

  it("returns [] when package is not installed at all (no throw)", async () => {
    await expect(getPackageExports("totally-missing-pkg")).resolves.toEqual([]);
  });
});

describe("scanFileForMethodCalls", () => {
  it("flags a named import whose method is absent from .d.ts", async () => {
    vol.fromJSON(
      {
        [`${WS}/node_modules/pkg-miss/package.json`]: JSON.stringify({
          name: "pkg-miss",
          version: "1.0.0",
          types: "index.d.ts",
        }),
        [`${WS}/node_modules/pkg-miss/index.d.ts`]: "export declare function ok(): void;\n",
        [`${WS}/src/a.ts`]: 'import { ok, missingName } from "pkg-miss";\n',
      },
      "/",
    );

    const res = await scanFileForMethodCalls(`${WS}/src/a.ts`, ["pkg-miss"]);
    expect(res.some((r) => r.method === "missingName" && r.exists === false)).toBe(true);
  });

  it("does NOT flag a valid method that exists in .d.ts", async () => {
    vol.fromJSON(
      {
        [`${WS}/node_modules/pkg-ok/package.json`]: JSON.stringify({
          name: "pkg-ok",
          version: "1.0.0",
          types: "index.d.ts",
        }),
        [`${WS}/node_modules/pkg-ok/index.d.ts`]: "export declare function findMany(): void;\n",
        [`${WS}/src/b.ts`]: 'import { findMany } from "pkg-ok";\n',
      },
      "/",
    );

    const res = await scanFileForMethodCalls(`${WS}/src/b.ts`, ["pkg-ok"]);
    expect(res).toEqual([]);
  });

  it("flags method from KNOWN_HALLUCINATIONS map even without .d.ts", async () => {
    vol.fromJSON(
      {
        [`${WS}/node_modules/@prisma/client/package.json`]: JSON.stringify({
          name: "@prisma/client",
          version: "5.0.0",
        }),
        [`${WS}/src/prisma-use.ts`]: [
          'import * as prisma from "@prisma/client";',
          "const { softDelete } = prisma;",
        ].join("\n"),
      },
      "/",
    );

    const res = await scanFileForMethodCalls(`${WS}/src/prisma-use.ts`, ["@prisma/client"]);
    expect(res.some((r) => r.method === "softDelete" && r.exists === false)).toBe(true);
  });

  it("handles import * as namespace without throwing — returns []", async () => {
    vol.fromJSON(
      {
        [`${WS}/node_modules/lodash/package.json`]: JSON.stringify({ name: "lodash", version: "4.0.0" }),
        [`${WS}/src/ns.ts`]: 'import * as lodash from "lodash";\n',
      },
      "/",
    );

    await expect(scanFileForMethodCalls(`${WS}/src/ns.ts`, ["lodash"])).resolves.toEqual([]);
  });

  it("flags only the missing method when mixed imports from same package", async () => {
    vol.fromJSON(
      {
        [`${WS}/node_modules/pkg-mix/package.json`]: JSON.stringify({
          name: "pkg-mix",
          version: "1.0.0",
          types: "index.d.ts",
        }),
        [`${WS}/node_modules/pkg-mix/index.d.ts`]: "export declare function good(): void;\n",
        [`${WS}/src/mix.ts`]: 'import { good, bad } from "pkg-mix";\n',
      },
      "/",
    );

    const res = await scanFileForMethodCalls(`${WS}/src/mix.ts`, ["pkg-mix"]);
    expect(res).toHaveLength(1);
    expect(res[0]!.method).toBe("bad");
  });

  it("returns [] and does not throw on a file with syntax errors", async () => {
    vol.fromJSON(
      {
        [`${WS}/node_modules/pkg-parse/package.json`]: JSON.stringify({
          name: "pkg-parse",
          version: "1.0.0",
          types: "index.d.ts",
        }),
        [`${WS}/node_modules/pkg-parse/index.d.ts`]: "export declare function a(): void;\n",
        [`${WS}/src/bad-parse.ts`]: 'import { a } from "pkg-parse";\n',
      },
      "/",
    );

    const spy = vi.spyOn(String.prototype, "matchAll").mockImplementation(function () {
      throw new Error("forced parse failure");
    });

    const res = await scanFileForMethodCalls(`${WS}/src/bad-parse.ts`, ["pkg-parse"]);
    spy.mockRestore();

    expect(res).toEqual([]);
  });

  it("result contains correct file path and line number", async () => {
    const body = ["line1", "line2", 'import { ghost } from "pkg-line";', "line4"].join("\n");
    vol.fromJSON(
      {
        [`${WS}/node_modules/pkg-line/package.json`]: JSON.stringify({
          name: "pkg-line",
          version: "1.0.0",
          types: "index.d.ts",
        }),
        [`${WS}/node_modules/pkg-line/index.d.ts`]: "export declare function real(): void;\n",
        [`${WS}/src/lines.ts`]: body,
      },
      "/",
    );

    const res = await scanFileForMethodCalls(`${WS}/src/lines.ts`, ["pkg-line"]);
    const hit = res.find((r) => r.method === "ghost");
    expect(hit?.file).toBe(`${WS}/src/lines.ts`);
    expect(hit?.line).toBe(3);
  });

  it("returns [] when package is not installed — no throw", async () => {
    vol.fromJSON({ [`${WS}/src/noinst.ts`]: 'import { x } from "ghost-pkg";\n' }, "/");

    const res = await scanFileForMethodCalls(`${WS}/src/noinst.ts`, ["ghost-pkg"]);
    expect(res).toEqual([]);
  });
});

describe("scanDirectory", () => {
  it("scans .ts .tsx .js .jsx recursively and returns method issues", async () => {
    vol.fromJSON(
      {
        [`${WS}/node_modules/multi-ext/package.json`]: JSON.stringify({
          name: "multi-ext",
          version: "1.0.0",
          types: "index.d.ts",
        }),
        [`${WS}/node_modules/multi-ext/index.d.ts`]: "export declare function ok(): void;\n",
        [`${WS}/root/a.ts`]: 'import { bad } from "multi-ext";\n',
        [`${WS}/root/b.tsx`]: 'import { bad2 } from "multi-ext";\n',
        [`${WS}/root/c.js`]: 'import { bad3 } from "multi-ext";\n',
        [`${WS}/root/d.jsx`]: 'import { bad4 } from "multi-ext";\n',
      },
      "/",
    );

    const res = await scanDirectory(`${WS}/root`, ["multi-ext"]);
    expect(res.length).toBeGreaterThanOrEqual(4);
  });

  it("skips node_modules entirely", async () => {
    vol.fromJSON(
      {
        [`${WS}/node_modules/hidden/package.json`]: JSON.stringify({ name: "hidden", version: "1.0.0" }),
        [`${WS}/node_modules/hidden/x.ts`]: 'import { z } from "hidden";\n',
        [`${WS}/src/only.ts`]: "// clean\n",
      },
      "/",
    );

    const res = await scanDirectory(WS, ["hidden"]);
    expect(res.every((r) => !r.file.includes("node_modules"))).toBe(true);
  });

  it("skips dist and build directories", async () => {
    vol.fromJSON(
      {
        [`${WS}/node_modules/skip-scan/package.json`]: JSON.stringify({
          name: "skip-scan",
          version: "1.0.0",
          types: "index.d.ts",
        }),
        [`${WS}/node_modules/skip-scan/index.d.ts`]: "export declare function ok(): void;\n",
        [`${WS}/dist/bad.ts`]: 'import { nope } from "skip-scan";\n',
        [`${WS}/build/bad.ts`]: 'import { nope2 } from "skip-scan";\n',
        [`${WS}/src/trigger.ts`]: 'import { nope3 } from "skip-scan";\n',
      },
      "/",
    );

    const res = await scanDirectory(WS, ["skip-scan"]);
    expect(res).toHaveLength(1);
    expect(res[0]!.file).toContain("/src/trigger.ts");
  });

  it("returns [] for directory with no source files", async () => {
    vol.fromJSON({ [`${WS}/empty/readme.txt`]: "hello" }, "/");

    await expect(scanDirectory(`${WS}/empty`, [])).resolves.toEqual([]);
  });

  it("finds files 5 levels deep", async () => {
    vol.fromJSON(
      {
        [`${WS}/node_modules/deep-scan/package.json`]: JSON.stringify({
          name: "deep-scan",
          version: "1.0.0",
          types: "index.d.ts",
        }),
        [`${WS}/node_modules/deep-scan/index.d.ts`]: "export declare function ok(): void;\n",
        [`${WS}/t1/t2/t3/t4/t5/deep.tsx`]: 'import { missing } from "deep-scan";\n',
      },
      "/",
    );

    const res = await scanDirectory(`${WS}/t1`, ["deep-scan"]);
    expect(res.some((r) => r.file.endsWith("t5/deep.tsx") && r.method === "missing")).toBe(true);
  });
});
