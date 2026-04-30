import chalk from "chalk";
import type { MethodResult, PackageResult, ScanReport } from "../types.js";

export function printReport(report: ScanReport): void {
  const line = "═══════════════════════════════════════════";

  const hallucinatedPkgs = report.packages.filter((p) => !p.exists);
  const deprecatedPkgs = report.packages.filter((p) => p.exists && p.deprecated);
  const outdatedPkgs = report.packages.filter(
    (p) => p.exists && Boolean(p.latestVersion) && isOutdatedMajor(p.version, p.latestVersion),
  );

  const hasIssues =
    hallucinatedPkgs.length > 0 || deprecatedPkgs.length > 0 || report.methods.length > 0;

  process.stdout.write(`${line}\n`);
  process.stdout.write(`  AI HALLUCINATION GUARD — Scan Results\n`);
  process.stdout.write(`${line}\n\n`);

  if (report.packages.length > 0) {
    process.stdout.write(`📦 PACKAGES (${report.packages.length} checked)\n\n`);
    for (const pkg of report.packages) {
      process.stdout.write(formatPackageLine(pkg) + "\n");
    }
    process.stdout.write("\n");
  }

  if (report.methods.length > 0) {
    process.stdout.write(`🔍 METHOD CALLS\n\n`);
    for (const m of report.methods) {
      process.stdout.write(formatMethodLine(m) + "\n");
      if (m.suggestion) {
        process.stdout.write(`     → Suggestion: ${m.suggestion}\n`);
      }
    }
    process.stdout.write("\n");
  }

  process.stdout.write(`${line}\n`);
  if (!hasIssues) {
    process.stdout.write(chalk.green(`  SUMMARY: no issues found\n`));
  } else {
    process.stdout.write(
      `  SUMMARY: ${report.summary.hallucinated} hallucinated, ${report.summary.deprecated} deprecated, ${report.summary.methodIssues} method issue\n`,
    );
    process.stdout.write(`  Run with --fix to get suggested replacements\n`);
  }
  process.stdout.write(`${line}\n`);

  // Keep lint from complaining about unused computed vars when summary differs.
  void outdatedPkgs;
}

function formatPackageLine(pkg: PackageResult): string {
  const namePad = pkg.name.padEnd(20, " ");
  if (!pkg.exists) {
    const hint = pkg.replacement ? ` — did you mean ${pkg.replacement}?` : "";
    return `  ${chalk.red("✗")} ${chalk.red(namePad)} ${chalk.red("[NOT ON REGISTRY]")}${hint}`;
  }

  if (pkg.deprecated) {
    const latest = pkg.latestVersion ? ` Latest: ${pkg.name}@${pkg.latestVersion}` : "";
    const msg = pkg.issues.find((i) => i && !i.toLowerCase().includes("deprecated")) ?? "";
    const replacement = pkg.replacement ? ` — ${chalk.yellow(`Use ${pkg.replacement} instead.`)}` : "";
    const tail = msg ? ` — ${msg}` : "";
    return `  ${chalk.yellow("⚠")} ${chalk.yellow(namePad)} ${chalk.yellow("[DEPRECATED]")}${replacement}${tail}${chalk.yellow(latest)}`;
  }

  if (pkg.latestVersion && isOutdatedMajor(pkg.version, pkg.latestVersion)) {
    return `  ${chalk.yellow("⚠")} ${chalk.yellow(namePad)} ${chalk.yellow("[OUTDATED]")} v${pkg.version} installed, v${pkg.latestVersion} available`;
  }

  return `  ${chalk.green("✓")} ${namePad} v${pkg.version} — ok`;
}

function formatMethodLine(m: MethodResult): string {
  const loc = `${m.file}:${m.line}`.padEnd(18, " ");
  const base = `${m.packageName}.${m.method}()`;
  if (!m.exists) {
    return `  ${chalk.yellow("✗")} ${chalk.yellow(loc)} ${chalk.yellow(base)} — ${chalk.yellow(
      "method does not exist",
    )}`;
  }
  return `  ${chalk.green("✓")} ${loc} ${base} — ok`;
}

function isOutdatedMajor(installed: string, latest: string): boolean {
  const i = majorOf(installed);
  const l = majorOf(latest);
  if (i === null || l === null) return false;
  return l - i > 1;
}

function majorOf(version: string): number | null {
  const m = version.trim().match(/^(\d+)(?:\.\d+)?(?:\.\d+)?/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}
