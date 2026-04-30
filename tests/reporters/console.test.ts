import { fs, vol } from "memfs";
import type { MethodResult, PackageResult, ScanReport } from "../../src/types.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { printReport } from "../../src/reporters/console.js";

vi.mock("node:fs", async () => {
  const { fs: mem } = await import("memfs");
  return mem;
});
vi.mock("node:fs/promises", async () => {
  const { fs: mem } = await import("memfs");
  return mem.promises;
});

function stripAnsi(s: string): string {
  return s.replace(/\u001b\[[0-9;]*m/g, "");
}

function makePkg(o: Partial<PackageResult> = {}): PackageResult {
  return {
    name: "pkg",
    version: "1.0.0",
    exists: true,
    deprecated: false,
    latestVersion: "1.0.0",
    issues: [],
    ...o,
  };
}

function makeMethod(o: Partial<MethodResult> = {}): MethodResult {
  return {
    file: "src/x.ts",
    line: 1,
    packageName: "p",
    method: "fake",
    exists: false,
    ...o,
  };
}

function makeReport(o: Partial<ScanReport> = {}): ScanReport {
  return {
    packages: [],
    methods: [],
    summary: { total: 0, hallucinated: 0, deprecated: 0, methodIssues: 0 },
    ...o,
  };
}

const stdoutChunks: string[] = [];

beforeEach(() => {
  vol.reset();
  expect(fs).toBeDefined();
  stdoutChunks.length = 0;
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    stdoutChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const out = () => stripAnsi(stdoutChunks.join(""));

describe("printReport", () => {
  it("hallucinated package → output contains name + /not found|not on registry/i", () => {
    printReport(
      makeReport({
        packages: [makePkg({ name: "bad-pkg", exists: false, latestVersion: "", issues: ["not on registry"] })],
        summary: { total: 1, hallucinated: 1, deprecated: 0, methodIssues: 0 },
      }),
    );
    const t = out();
    expect(t).toMatch(/bad-pkg/);
    expect(t).toMatch(/not found|not on registry/i);
  });

  it("deprecated package → output contains name + /deprecated/i + replacement", () => {
    printReport(
      makeReport({
        packages: [
          makePkg({
            name: "legacy",
            exists: true,
            deprecated: true,
            latestVersion: "2.0.0",
            replacement: "got",
            issues: ["Package is deprecated", "msg"],
          }),
        ],
        summary: { total: 1, hallucinated: 0, deprecated: 1, methodIssues: 0 },
      }),
    );
    const t = out();
    expect(t).toMatch(/legacy/);
    expect(t).toMatch(/deprecated/i);
    expect(t).toMatch(/got/);
  });

  it("method issue → output contains file, line number, method name", () => {
    printReport(
      makeReport({
        methods: [makeMethod({ file: "src/app.ts", line: 42, packageName: "zod", method: "parseStrict" })],
        summary: { total: 1, hallucinated: 0, deprecated: 0, methodIssues: 1 },
      }),
    );
    const t = out();
    expect(t).toMatch(/src\/app\.ts/);
    expect(t).toMatch(/42/);
    expect(t).toMatch(/parseStrict/);
  });

  it("zero issues → output matches /no issues|all.*passed|safe/i", () => {
    printReport(makeReport());
    expect(out()).toMatch(/no issues|all.*passed|safe/i);
  });

  it("summary shows correct numeric counts", () => {
    printReport(
      makeReport({
        packages: [
          makePkg({ name: "a", exists: false, latestVersion: "", issues: [] }),
          makePkg({ name: "b", exists: false, latestVersion: "", issues: [] }),
          makePkg({ name: "c", exists: true, deprecated: true, latestVersion: "1", issues: ["d"] }),
        ],
        methods: [makeMethod({ exists: false })],
        summary: { total: 6, hallucinated: 2, deprecated: 1, methodIssues: 1 },
      }),
    );
    const t = out();
    expect(t).toMatch(/2 hallucinated/);
    expect(t).toMatch(/1 deprecated/);
    expect(t).toMatch(/1 method issue/);
  });

  it("empty report does not throw and writes to stdout at least once", () => {
    expect(() => printReport(makeReport())).not.toThrow();
    expect((process.stdout.write as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0);
  });

  it.todo("printReport JSON mode: JSON is emitted by runCli when using --json, not by printReport");
});
