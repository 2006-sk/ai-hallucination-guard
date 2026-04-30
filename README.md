# ai-hallucination-guard

Detects AI-hallucinated package names and method calls in your codebase

## The problem

AI coding tools sometimes suggest packages that don’t exist, or methods that aren’t real exports. That can waste engineering time, but it’s also a security risk: attackers have exploited these suggestions via dependency confusion / typosquatting. This tool helps you catch obvious hallucinations early—locally and in CI.

## Install

```bash
npm install -g ai-hallucination-guard
```

## Quick start

![Demo GIF (placeholder)](./docs/demo.gif)

```bash
hallucination-guard scan
hallucination-guard scan --methods
hallucination-guard scan --path ./other/project --json
```

## What it checks

- **Package existence**: npm + PyPI packages that don’t exist on their registries.
- **Deprecation/yanks**: deprecated npm packages and yanked PyPI packages (with best-effort replacement hints).
- **Method exports**: imported named exports / namespace method calls that don’t exist in a package’s public API (best-effort v1).

## Output example

```text
═══════════════════════════════════════════
  AI HALLUCINATION GUARD — Scan Results
═══════════════════════════════════════════

[PACKAGES] (23 checked)

  x fake-axios           [NOT ON REGISTRY] — did you mean axios?
  ! request              [DEPRECATED] — Use node-fetch or got instead. Latest: got@14.0
  ! lodash               [OUTDATED] v3.10.0 installed, v4.17.21 available
  ok express             v4.18.2 — ok

[METHOD CALLS]

  x src/db/user.ts:42    prisma.softDelete() — method does not exist on prisma@5.x
     → Suggestion: use prisma.delete() instead

═══════════════════════════════════════════
  SUMMARY: 2 hallucinated, 1 deprecated, 1 method issue
  Run with --fix to get suggested replacements
═══════════════════════════════════════════
```

## CI/CD integration

```yaml
name: Hallucination Guard
on: [push, pull_request]
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
      - run: npx ai-hallucination-guard scan
```

## Contributing

PRs welcome. Please run `npm test` and keep changes focused (small diffs, clear behavior, and good tests).

## License

MIT

## Commands

- `npm run build`
- `npm run dev`
- `npm test`

## CLI

After building, the binary is exposed as `hallucination-guard`.
