import { afterAll, afterEach, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

afterAll(() => {
  vi.resetModules();
});

/**
 * Stub `globalThis.fetch`. For each request, the first map key that is contained in the request URL wins.
 * Unknown URLs get `{ status: 404, body: {} }`.
 */
export function mockFetch(urlResponseMap: Record<string, { status: number; body: object }>): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const keys = Object.keys(urlResponseMap);
      const key = keys.find((k) => url === k || url.includes(k));
      const spec = key ? urlResponseMap[key]! : { status: 404, body: {} };
      return new Response(JSON.stringify(spec.body), {
        status: spec.status,
        headers: { "content-type": "application/json" },
      });
    }),
  );
}

export function mockFetchError(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("network error");
    }),
  );
}

/** Realistic npm packument shape for the `react` package (fixture). */
export const NPM_REACT_RESPONSE = {
  name: "react",
  "dist-tags": { latest: "18.2.0" },
  versions: {
    "18.2.0": {
      version: "18.2.0",
      description: "React is a JavaScript library for building user interfaces.",
    },
  },
} as const;

/** npm packument fixture for a deprecated `request`-style package. */
export const NPM_DEPRECATED_RESPONSE = {
  name: "request",
  "dist-tags": { latest: "2.88.2" },
  versions: {
    "2.88.2": {
      version: "2.88.2",
      deprecated: "Please use got or node-fetch instead",
    },
  },
} as const;

/** PyPI `/pypi/{name}/json` fixture for `requests`. */
export const PYPI_REQUESTS_RESPONSE = {
  info: {
    name: "requests",
    version: "2.31.0",
    summary: "Python HTTP for Humans.",
    requires_python: ">=3.7",
    yanked: false,
  },
  releases: {
    "2.31.0": [{ packagetype: "bdist_wheel", python_version: "py3", requires_python: ">=3.7" }],
  },
} as const;

/** PyPI fixture for a yanked distribution. */
export const PYPI_YANKED_RESPONSE = {
  info: {
    name: "yanked-example",
    version: "1.0.0",
    yanked: true,
    yanked_reason: "Use httpx instead",
  },
  releases: {},
} as const;
