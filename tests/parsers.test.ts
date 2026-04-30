import { describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parsePackageJson } from "../src/parsers/packageJson.js";
import { parseRequirements } from "../src/parsers/requirements.js";

describe("parsers", () => {
  it("parses package.json dependencies and defaults missing to empty", () => {
    const dir = mkdtempSync(join(tmpdir(), "ahg-"));
    const p = join(dir, "package.json");
    writeFileSync(
      p,
      JSON.stringify({ dependencies: { chalk: "^5.0.0" }, devDependencies: { vitest: "~3.0.0" } }),
      "utf8",
    );

    expect(parsePackageJson(p)).toEqual({
      dependencies: { chalk: "^5.0.0" },
      devDependencies: { vitest: "~3.0.0" },
    });
  });

  it("parses requirements.txt lines and operators", () => {
    const dir = mkdtempSync(join(tmpdir(), "ahg-"));
    const p = join(dir, "requirements.txt");
    writeFileSync(
      p,
      [
        "# comment",
        "",
        "requests==2.28.0",
        "flask>=2.0",
        "django",
        "package[extra]==1.0",
        "-r other.txt",
        "--index-url https://example.com/simple",
        "https://example.com/pkg.whl",
      ].join("\n"),
      "utf8",
    );

    expect(parseRequirements(p)).toEqual({
      requests: "2.28.0",
      flask: ">=2.0",
      django: "",
      package: "1.0",
    });
  });

  it("parses pyproject.toml [project] dependencies array", () => {
    const dir = mkdtempSync(join(tmpdir(), "ahg-"));
    const p = join(dir, "pyproject.toml");
    writeFileSync(
      p,
      [
        "[project]",
        'dependencies = ["requests==2.28.0",',
        '  "flask>=2.0",',
        '  "package[extra]==1.0"',
        "]",
      ].join("\n"),
      "utf8",
    );

    expect(parseRequirements(p)).toEqual({
      requests: "2.28.0",
      flask: ">=2.0",
      package: "1.0",
    });
  });
});

