import { fs as memfsFs, vol } from "memfs";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async () => {
  const { fs } = await import("memfs");
  return fs;
});

import { _internal, checkAllPypiPackages, checkPypiPackage } from "../../src/checkers/pypi.js";
import { parseRequirements } from "../../src/parsers/requirements.js";
import { mockFetch, mockFetchError, PYPI_REQUESTS_RESPONSE, PYPI_YANKED_RESPONSE } from "../setup.js";

beforeEach(() => {
  vol.reset();
});

describe("checkPypiPackage", () => {
  it("returns exists: true for a real package", async () => {
    mockFetch({
      "pypi.org/pypi/requests/json": { status: 200, body: PYPI_REQUESTS_RESPONSE },
    });

    const result = await checkPypiPackage("requests", "2.31.0");

    expect(result.exists).toBe(true);
    expect(result.deprecated).toBe(false);
    expect(result.issues.length).toBe(0);
  });

  it("returns exists: false for hallucinated package", async () => {
    mockFetch({
      "pypi.org/pypi/definitely-not-a-real-package-xyz/json": { status: 404, body: {} },
    });

    const result = await checkPypiPackage("definitely-not-a-real-package-xyz", "1.0.0");

    expect(result.exists).toBe(false);
    expect(result.issues.some((i) => /not found|pypi/i.test(i))).toBe(true);
  });

  it("detects yanked package as deprecated", async () => {
    mockFetch({
      "pypi.org/pypi/old-package/json": { status: 200, body: PYPI_YANKED_RESPONSE },
    });

    const result = await checkPypiPackage("old-package", "1.0.0");

    expect(result.deprecated).toBe(true);
    expect(result.replacement?.toLowerCase()).toContain("httpx");
    expect(result.issues.length).toBeGreaterThan(0);
  });

  it("treats yanked package without yanked_reason as deprecated with no replacement", async () => {
    mockFetch({
      "pypi.org/pypi/yanked-no-reason/json": {
        status: 200,
        body: { info: { name: "yanked-no-reason", version: "1.0.0", yanked: true }, releases: {} },
      },
    });

    const result = await checkPypiPackage("yanked-no-reason", "1.0.0");

    expect(result.deprecated).toBe(true);
    expect(result.replacement).toBeUndefined();
  });

  it("yanked with reason that does not match replacement pattern leaves replacement undefined", async () => {
    mockFetch({
      "pypi.org/pypi/yanked-plain/json": {
        status: 200,
        body: {
          info: {
            name: "yanked-plain",
            version: "1.0.0",
            yanked: true,
            yanked_reason: "Removed from index due to policy violation.",
          },
          releases: {},
        },
      },
    });

    const result = await checkPypiPackage("yanked-plain", "1.0.0");

    expect(result.deprecated).toBe(true);
    expect(result.replacement).toBeUndefined();
  });

  it("normalises package names before API call", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return new Response(
        JSON.stringify({
          info: { name: "my-package", version: "1.0.0", yanked: false },
          releases: {},
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    await checkPypiPackage("My_Package", "1.0.0");

    expect(fetchSpy).toHaveBeenCalled();
    expect(String(fetchSpy.mock.calls[0]![0])).toContain("my-package");
    fetchSpy.mockRestore();
  });

  it("uses fresh registry cache without calling fetch again", async () => {
    mockFetch({
      "pypi.org/pypi/cached-pkg/json": {
        status: 200,
        body: { info: { name: "cached-pkg", version: "2.0.0", yanked: false }, releases: {} },
      },
    });

    const fetchFn = globalThis.fetch as ReturnType<typeof vi.fn>;
    await checkPypiPackage("cached-pkg", "2.0.0");
    const callsAfterFirst = fetchFn.mock.calls.length;

    await checkPypiPackage("cached-pkg", "2.0.0");

    expect(fetchFn.mock.calls.length).toBe(callsAfterFirst);
  });

  it("handles version comparison for outdated packages", async () => {
    mockFetch({
      "pypi.org/pypi/somepkg/json": {
        status: 200,
        body: {
          info: { name: "somepkg", version: "3.0.0", yanked: false },
          releases: {},
        },
      },
    });

    const result = await checkPypiPackage("somepkg", "1.5.0");

    expect(result.issues.some((i) => /major|behind|latest/i.test(i) && /3\.0\.0/.test(i))).toBe(true);
  });

  it("handles network failure gracefully", async () => {
    mockFetchError();

    const result = await checkPypiPackage("requests", "2.0.0");
    expect(result.exists).toBe(true);
    expect(result.issues.some((i) => i.includes("Could not verify"))).toBe(true);
  });

  it("handles non-200 registry status", async () => {
    mockFetch({
      "pypi.org/pypi/down/json": { status: 503, body: {} },
    });

    const result = await checkPypiPackage("down", "1.0.0");

    expect(result.exists).toBe(true);
    expect(result.issues.some((i) => i.includes("Could not verify"))).toBe(true);
  });

  it("handles response with missing info block", async () => {
    mockFetch({
      "pypi.org/pypi/no-info/json": { status: 200, body: { releases: {} } },
    });

    const result = await checkPypiPackage("no-info", "1.0.0");

    expect(result.exists).toBe(true);
    expect(result.latestVersion).toBe("");
    expect(result.deprecated).toBe(false);
  });

  it("handles invalid JSON on 200 response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not-json{{{", { status: 200, headers: { "content-type": "application/json" } })),
    );

    const result = await checkPypiPackage("bad-json", "1.0.0");

    expect(result.exists).toBe(true);
    expect(result.issues.some((i) => i.includes("Could not verify"))).toBe(true);
  });

  it("ignores registry cache write failures", async () => {
    mockFetch({
      "pypi.org/pypi/cache-write-fail/json": {
        status: 200,
        body: { info: { name: "cache-write-fail", version: "1.0.0", yanked: false }, releases: {} },
      },
    });

    const spy = vi.spyOn(memfsFs, "writeFileSync").mockImplementationOnce(() => {
      throw new Error("write failed");
    });

    const result = await checkPypiPackage("cache-write-fail", "1.0.0");

    spy.mockRestore();
    expect(result.exists).toBe(true);
    expect(result.latestVersion).toBe("1.0.0");
  });

  it("does not flag outdated for single-major gap", async () => {
    mockFetch({
      "pypi.org/pypi/wheel/json": {
        status: 200,
        body: { info: { name: "wheel", version: "2.0.0", yanked: false }, releases: {} },
      },
    });

    const result = await checkPypiPackage("wheel", "1.9.0");
    expect(result.issues.filter((i) => i.includes("major behind"))).toHaveLength(0);
  });
});

describe("checkAllPypiPackages", () => {
  it("processes multiple packages in batches", async () => {
    mockFetch({
      "pypi.org/pypi/requests/json": { status: 200, body: PYPI_REQUESTS_RESPONSE },
      "pypi.org/pypi/flask/json": {
        status: 200,
        body: { info: { name: "flask", version: "3.0.0", yanked: false }, releases: {} },
      },
      "pypi.org/pypi/fake-pkg/json": { status: 404, body: {} },
    });

    const results = await checkAllPypiPackages({
      requests: "==2.31.0",
      flask: ">=2.0",
      "fake-pkg": "1.0.0",
    });

    expect(results).toHaveLength(3);
    expect(results.find((r) => r.name === "fake-pkg")?.exists).toBe(false);
    expect(results.find((r) => r.name === "requests")?.exists).toBe(true);
    expect(results.find((r) => r.name === "flask")?.exists).toBe(true);
  });

  it("limits concurrent fetch to at most 5", async () => {
    let active = 0;
    let maxActive = 0;

    const body = { info: { name: "x", version: "1.0.0", yanked: false }, releases: {} };

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 12));
        active -= 1;
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );

    const pkgs: Record<string, string> = {};
    for (let i = 0; i < 12; i++) pkgs[`rate-pypi-${i}`] = "==1.0.0";

    await checkAllPypiPackages(pkgs);

    expect(maxActive).toBeLessThanOrEqual(5);
  });
});

describe("pypi _internal helpers", () => {
  it("chunk returns single batch when size is 0 or negative", () => {
    expect(_internal.chunk([1, 2, 3], 0)).toEqual([[1, 2, 3]]);
    expect(_internal.chunk([1, 2], -1)).toEqual([[1, 2]]);
  });

  it("majorOf returns null for non-numeric leading version", () => {
    expect(_internal.majorOf("not-a-version")).toBeNull();
    expect(_internal.majorOf(`${"9".repeat(400)}.0.0`)).toBeNull();
  });

  it("extractReplacement parses use X instead", () => {
    expect(_internal.extractReplacement("Use httpx instead.")).toBe("httpx");
    expect(_internal.extractReplacement("no replacement here")).toBeUndefined();
    expect(_internal.extractReplacement("Use  instead")).toBeUndefined();
    expect(_internal.extractReplacement("please use    instead")).toBeUndefined();
  });

  it("stripRequirementOperator strips common operators", () => {
    expect(_internal.stripRequirementOperator("==1.0.0")).toBe("1.0.0");
    expect(_internal.stripRequirementOperator(">=2.0")).toBe("2.0");
  });
});

describe("parseRequirements integration", () => {
  beforeEach(() => {
    vol.reset();
  });

  it("parses == pinned version", () => {
    vol.fromJSON({ "/project/requirements.txt": "requests==2.28.0\n" }, "/");

    expect(parseRequirements("/project/requirements.txt")).toEqual({ requests: "2.28.0" });
  });

  it("parses >= version constraint", () => {
    vol.fromJSON({ "/project/requirements.txt": "flask>=2.0.0\n" }, "/");

    expect(parseRequirements("/project/requirements.txt")).toEqual({ flask: ">=2.0.0" });
  });

  it("parses ~= compatible release", () => {
    vol.fromJSON({ "/project/requirements.txt": "django~=4.2\n" }, "/");

    expect(parseRequirements("/project/requirements.txt")).toEqual({ django: "~=4.2" });
  });

  it("strips package extras", () => {
    vol.fromJSON({ "/project/requirements.txt": "requests[security]==2.28.0\n" }, "/");

    expect(parseRequirements("/project/requirements.txt")).toEqual({ requests: "2.28.0" });
  });

  it("skips comment lines", () => {
    vol.fromJSON({ "/project/requirements.txt": "# this is a comment\nrequests==2.28.0\n" }, "/");

    expect(parseRequirements("/project/requirements.txt")).toEqual({ requests: "2.28.0" });
  });

  it("skips blank lines", () => {
    vol.fromJSON({ "/project/requirements.txt": "\n\n\nrequests==2.28.0\n\n" }, "/");

    expect(parseRequirements("/project/requirements.txt")).toEqual({ requests: "2.28.0" });
  });

  it("skips -r includes and --index-url options", () => {
    vol.fromJSON(
      {
        "/project/requirements.txt": "-r base.txt\n--index-url https://pypi.org/simple\nflask==2.0\n",
      },
      "/",
    );

    expect(parseRequirements("/project/requirements.txt")).toEqual({ flask: "2.0" });
  });

  it("handles package with no version pinned", () => {
    vol.fromJSON({ "/project/requirements.txt": "flask\n" }, "/");

    expect(parseRequirements("/project/requirements.txt")).toEqual({ flask: "" });
  });

  it("parses multi-package file correctly", () => {
    const content = [
      "# project deps",
      "",
      "requests==2.28.0",
      "",
      "flask>=2.0.0",
      "django~=4.2",
      "uvicorn==0.22.0",
      "",
      "# http client",
      "httpx==0.24.0",
    ].join("\n");

    vol.fromJSON({ "/project/requirements.txt": content }, "/");

    const result = parseRequirements("/project/requirements.txt");

    expect(Object.keys(result).sort()).toEqual(["django", "flask", "httpx", "requests", "uvicorn"].sort());
    expect(result).toMatchObject({
      requests: "2.28.0",
      flask: ">=2.0.0",
      django: "~=4.2",
      uvicorn: "0.22.0",
      httpx: "0.24.0",
    });
  });

  it("throws helpful error for missing file", () => {
    expect(() => parseRequirements("/nonexistent/requirements.txt")).toThrow(/\/nonexistent\/requirements\.txt/);
  });
});
