import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fs, vol } from "memfs";

vi.mock("node:fs", async () => {
  const { fs: mem } = await import("memfs");
  return mem;
});
vi.mock("node:fs/promises", async () => {
  const { fs: mem } = await import("memfs");
  return mem.promises;
});

import { checkAllNpmPackages } from "../../src/checkers/npm.js";
import { checkAllPypiPackages } from "../../src/checkers/pypi.js";
import { scanDirectory } from "../../src/checkers/methods.js";
import { parsePackageJson } from "../../src/parsers/packageJson.js";
import { parseRequirements } from "../../src/parsers/requirements.js";
import type { PackageResult, ScanReport } from "../../src/types.js";
import { mockFetch, NPM_DEPRECATED_RESPONSE, NPM_REACT_RESPONSE, PYPI_REQUESTS_RESPONSE } from "../setup.js";

const PROJ = "/virtual-proj";
const PYPROJ = "/virtual-pyproj";

async function runFullScan(targetDir: string): Promise<ScanReport> {
  const pkgJsonPath = join(targetDir, "package.json");
  const reqTxtPath = join(targetDir, "requirements.txt");
  const pyprojectPath = join(targetDir, "pyproject.toml");

  const hasPkgJson = existsSync(pkgJsonPath);
  const hasReqTxt = existsSync(reqTxtPath);
  const hasPyproject = existsSync(pyprojectPath);

  const packagesToCheck: Array<Promise<PackageResult[]>> = [];
  if (hasPkgJson) {
    const { dependencies, devDependencies } = parsePackageJson(pkgJsonPath);
    packagesToCheck.push(checkAllNpmPackages({ ...dependencies, ...devDependencies }));
  }
  if (hasReqTxt || hasPyproject) {
    const pyPath = hasReqTxt ? reqTxtPath : pyprojectPath;
    packagesToCheck.push(checkAllPypiPackages(parseRequirements(pyPath)));
  }

  const installedPackages: string[] = [];
  if (hasPkgJson) {
    const { dependencies, devDependencies } = parsePackageJson(pkgJsonPath);
    installedPackages.push(...Object.keys({ ...dependencies, ...devDependencies }));
  }

  const methodChecks = [scanDirectory(targetDir, installedPackages)];

  const [pkgNested, methodNested] = await Promise.all([Promise.all(packagesToCheck), Promise.all(methodChecks)]);
  const packages = pkgNested.flat();
  const methods = methodNested.flat();

  return {
    packages,
    methods,
    summary: {
      total: packages.length + methods.length,
      hallucinated: packages.filter((p) => !p.exists).length,
      deprecated: packages.filter((p) => p.exists && p.deprecated).length,
      methodIssues: methods.filter((m) => !m.exists).length,
    },
  };
}

describe("npm project full scan", () => {
  beforeEach(() => {
    vol.reset();
    vi.unstubAllGlobals();
    expect(fs).toBeDefined();
    vi.spyOn(process, "cwd").mockReturnValue(PROJ);

    mockFetch({
      "registry.npmjs.org/react": { status: 200, body: NPM_REACT_RESPONSE },
      "registry.npmjs.org/totally-fake-package-xyz": { status: 404, body: {} },
      "registry.npmjs.org/request": { status: 200, body: NPM_DEPRECATED_RESPONSE },
      "registry.npmjs.org/typescript": {
        status: 200,
        body: {
          "dist-tags": { latest: "5.5.4" },
          versions: { "5.5.4": { version: "5.5.4" } },
        },
      },
      // npm uses encodeURIComponent — scoped name becomes %40prisma%2Fclient
      "registry.npmjs.org/%40prisma%2Fclient": {
        status: 200,
        body: {
          "dist-tags": { latest: "5.0.0" },
          versions: { "5.0.0": { version: "5.0.0" } },
        },
      },
    });

    vol.fromJSON(
      {
        [`${PROJ}/.keep`]: "",
        [`${PROJ}/package.json`]: JSON.stringify({
          dependencies: {
            react: "^18.0.0",
            "totally-fake-package-xyz": "^1.0.0",
            request: "^2.88.0",
            "@prisma/client": "^5.0.0",
          },
          devDependencies: { typescript: "^5.0.0" },
        }),
        [`${PROJ}/src/index.ts`]: 'import { softDelete } from "@prisma/client";\n',
        [`${PROJ}/node_modules/@prisma/client/package.json`]: JSON.stringify({ types: "index.d.ts" }),
        [`${PROJ}/node_modules/@prisma/client/index.d.ts`]:
          "export declare function findMany(args: any): any;\n",
      },
      "/",
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("hallucinated package appears in report with exists: false", async () => {
    const report = await runFullScan(PROJ);
    const row = report.packages.find((p) => p.name === "totally-fake-package-xyz");
    expect(row?.exists).toBe(false);
  });

  it("deprecated package appears with deprecated: true", async () => {
    const report = await runFullScan(PROJ);
    const row = report.packages.find((p) => p.name === "request");
    expect(row?.deprecated).toBe(true);
  });

  it("method hallucination appears in report with exists: false", async () => {
    const report = await runFullScan(PROJ);
    expect(report.methods.some((m) => m.method === "softDelete" && m.exists === false)).toBe(true);
  });

  it("summary counts are: hallucinated 1, deprecated 1, methodIssues 1, total 6", async () => {
    const report = await runFullScan(PROJ);
    expect(report.summary.hallucinated).toBe(1);
    expect(report.summary.deprecated).toBe(1);
    expect(report.summary.methodIssues).toBe(1);
    expect(report.summary.total).toBe(6);
  });

  it("clean project (all real packages, no bad methods) → summary issue counts all zero", async () => {
    vol.reset();
    vi.unstubAllGlobals();
    vi.spyOn(process, "cwd").mockReturnValue(PROJ);
    mockFetch({
      "registry.npmjs.org/react": { status: 200, body: NPM_REACT_RESPONSE },
      "registry.npmjs.org/typescript": {
        status: 200,
        body: {
          "dist-tags": { latest: "5.5.4" },
          versions: { "5.5.4": { version: "5.5.4" } },
        },
      },
    });
    vol.fromJSON(
      {
        [`${PROJ}/.keep`]: "",
        [`${PROJ}/package.json`]: JSON.stringify({
          dependencies: { react: "^18.0.0", typescript: "^5.0.0" },
        }),
        [`${PROJ}/src/index.ts`]: 'import { findMany } from "@prisma/client";\n',
        [`${PROJ}/node_modules/@prisma/client/package.json`]: JSON.stringify({ types: "index.d.ts" }),
        [`${PROJ}/node_modules/@prisma/client/index.d.ts`]:
          "export declare function findMany(args: any): any;\n",
      },
      "/",
    );

    const report = await runFullScan(PROJ);
    expect(report.summary.hallucinated).toBe(0);
    expect(report.summary.deprecated).toBe(0);
    expect(report.summary.methodIssues).toBe(0);
  });
});

describe("python project full scan", () => {
  beforeEach(() => {
    vol.reset();
    vi.unstubAllGlobals();
    vi.spyOn(process, "cwd").mockReturnValue(PYPROJ);
    mockFetch({
      "pypi.org/pypi/requests/json": { status: 200, body: PYPI_REQUESTS_RESPONSE },
      "pypi.org/pypi/totally-fake-python-pkg/json": { status: 404, body: {} },
      "pypi.org/pypi/httplib2/json": {
        status: 200,
        body: {
          info: {
            name: "httplib2",
            version: "0.22.0",
            yanked: true,
            yanked_reason: "Use httpx instead",
          },
          releases: {},
        },
      },
    });

    vol.fromJSON(
      {
        [`${PYPROJ}/.keep`]: "",
        [`${PYPROJ}/requirements.txt`]: [
          "requests==2.31.0",
          "totally-fake-python-pkg==1.0.0",
          "httplib2==0.22.0",
        ].join("\n"),
      },
      "/",
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("hallucinated PyPI package has exists: false", async () => {
    const report = await runFullScan(PYPROJ);
    const row = report.packages.find((p) => p.name === "totally-fake-python-pkg");
    expect(row?.exists).toBe(false);
  });

  it("yanked package has deprecated: true", async () => {
    const report = await runFullScan(PYPROJ);
    const row = report.packages.find((p) => p.name === "httplib2");
    expect(row?.deprecated).toBe(true);
  });

  it("summary shows hallucinated: 1, deprecated: 1", async () => {
    const report = await runFullScan(PYPROJ);
    expect(report.summary.hallucinated).toBe(1);
    expect(report.summary.deprecated).toBe(1);
  });
});
