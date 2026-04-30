import { afterEach, describe, expect, it, vi } from "vitest";

const readFileSync = vi.fn<(path: string, encoding: string) => string>();
const readFile = vi.fn<(path: string, encoding: string) => Promise<string>>();

vi.mock("node:fs", () => ({
  readFileSync: (path: string, encoding: string) => readFileSync(path, encoding),
}));

vi.mock("node:fs/promises", () => ({
  readFile: (path: string, encoding: string) => readFile(path, encoding),
  readdir: vi.fn(),
}));

describe("checkers/methods", () => {
  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    readFileSync.mockReset();
    readFile.mockReset();
  });

  it("import { softDelete } from '@prisma/client' is flagged", async () => {
    const { scanFileForMethodCalls } = await import("../src/checkers/methods.js");

    readFile.mockResolvedValueOnce('import { softDelete } from "@prisma/client";\nsoftDelete();\n');

    readFileSync.mockImplementation((path) => {
      if (String(path).includes("node_modules/@prisma/client/package.json")) {
        return JSON.stringify({ name: "@prisma/client", version: "5.0.0", types: "./index.d.ts" });
      }
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });

    readFile.mockImplementation(async (path) => {
      if (String(path).endsWith("index.d.ts")) {
        return "export class PrismaClient {}\nexport const Prisma: unknown;\n";
      }
      return 'import { softDelete } from "@prisma/client";\nsoftDelete();\n';
    });

    const res = await scanFileForMethodCalls("/repo/src/db/user.ts", ["@prisma/client"]);
    expect(res.some((r) => r.packageName === "@prisma/client" && r.method === "softDelete" && r.exists === false)).toBe(
      true,
    );
  });

  it("import { get } from 'lodash' is not flagged (get exists)", async () => {
    const { scanFileForMethodCalls } = await import("../src/checkers/methods.js");

    readFileSync.mockImplementation((path) => {
      if (String(path).includes("node_modules/lodash/package.json")) {
        return JSON.stringify({ name: "lodash", version: "4.0.0", types: "./index.d.ts" });
      }
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });

    readFile.mockImplementation(async (path) => {
      if (String(path).endsWith("index.d.ts")) {
        return "export function get(): unknown;\nexport function set(): unknown;\n";
      }
      return 'import { get } from "lodash";\nget({a:1}, "a");\n';
    });

    const res = await scanFileForMethodCalls("/repo/src/app.ts", ["lodash"]);
    expect(res.length).toBe(0);
  });

  it("import statement from unknown package is skipped gracefully", async () => {
    const { scanFileForMethodCalls } = await import("../src/checkers/methods.js");

    readFileSync.mockImplementation(() => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });

    readFile.mockResolvedValue('import { whatever } from "unknown-pkg";\nwhatever();\n');

    const res = await scanFileForMethodCalls("/repo/src/app.ts", ["unknown-pkg"]);
    expect(res.length).toBe(0);
  });
});
