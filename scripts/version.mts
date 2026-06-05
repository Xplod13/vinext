#!/usr/bin/env node
/**
 * version.mts — `changeset version` + bottom `## Contributors` list.
 *
 * Used as the `version:` command for `changesets/action` in
 * .github/workflows/release.yml. It:
 *
 *   1. Runs `changeset version`, which consumes every changeset (auto + manual),
 *      bumps each package's version, writes/updates its CHANGELOG.md, and
 *      cascades internal-dependency bumps.
 *   2. For each package whose version changed, resolves the unique GitHub
 *      contributor @logins across the release commit range (prior tag..HEAD)
 *      using a `gh api .../commits/{sha}` resolver, then appends a
 *      `## Contributors` block to the END of the newest CHANGELOG.md section
 *      (a hard requirement of the migration).
 *
 * Run directly on Node (>=24, which strips types natively):
 *   node scripts/version.mts
 *
 * The CHANGELOG-rewrite logic (`insertContributors`) is a pure, unit-tested
 * function. The git/gh/network glue around it is impure and only runs in CI.
 *
 * Env: GITHUB_TOKEN (for `gh api`), GITHUB_REPOSITORY ("owner/repo").
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { discoverPublishablePackages } from "./create-changeset.mts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

/**
 * Insert (or replace) a `## Contributors` block at the END of the NEWEST version
 * section of a CHANGELOG, leaving every older section untouched. Pure function.
 *
 * Conventions (changesets' default changelog format):
 *   - Line 1 is the `# <package-name>` title.
 *   - Each release section starts with `## <version>`.
 *   - The newest section is the first `## ` heading after the title.
 *
 * The contributors block is placed at the end of that newest section, just
 * before the next older `## ` heading (or at EOF if it is the only section).
 * Logins are deduped and sorted; each rendered as `@login` on its own line.
 *
 * @param changelog full CHANGELOG.md text
 * @param logins    contributor logins (with or without leading `@`)
 * @returns the rewritten changelog (unchanged if no section / no logins)
 */
export function insertContributors(changelog: string, logins: string[]): string {
  const cleaned = dedupeSortLogins(logins);
  if (cleaned.length === 0) return changelog;

  const lines = changelog.split("\n");

  // Find the first version heading (newest section start).
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) {
      start = i;
      break;
    }
  }
  if (start === -1) return changelog; // no release section to annotate

  // Find the next *version* heading (older section start), or EOF. A
  // `## Contributors` heading is NOT a section boundary — it belongs to the
  // current section (we append it ourselves), so skip it. This keeps the
  // function idempotent across re-runs.
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i]) && !/^##\s+Contributors\s*$/i.test(lines[i])) {
      end = i;
      break;
    }
  }

  // Slice out the newest section's lines [start, end).
  let section = lines.slice(start, end);

  // Remove any pre-existing `## Contributors` block within this section so the
  // function is idempotent (re-running version doesn't stack duplicates).
  section = stripContributorsBlock(section);

  // Trim trailing blank lines inside the section before appending.
  while (section.length > 0 && section[section.length - 1].trim() === "") {
    section.pop();
  }

  const block = ["", "## Contributors", "", ...cleaned.map((l) => `- @${l}`)];
  const rebuiltSection = [...section, ...block];

  const before = lines.slice(0, start);
  const after = lines.slice(end);
  // Ensure a blank line separates the appended block from the next section.
  const joinedAfter = after.length > 0 && after[0].trim() !== "" ? ["", ...after] : after;

  return [...before, ...rebuiltSection, ...joinedAfter].join("\n");
}

/** Remove a `## Contributors` heading and its bullet list from a section's lines. */
function stripContributorsBlock(sectionLines: string[]): string[] {
  const idx = sectionLines.findIndex((l) => /^##\s+Contributors\s*$/i.test(l));
  if (idx === -1) return sectionLines;
  // Drop from the heading to the end of the section (Contributors is always last).
  return sectionLines.slice(0, idx);
}

/**
 * Normalize, dedupe (case-insensitive) and sort contributor logins.
 * Strips a leading `@`, drops empties.
 */
export function dedupeSortLogins(logins: string[]): string[] {
  const byLower = new Map<string, string>();
  for (const raw of logins ?? []) {
    if (typeof raw !== "string") continue;
    const login = raw.trim().replace(/^@+/, "");
    if (!login) continue;
    const key = login.toLowerCase();
    if (!byLower.has(key)) byLower.set(key, login);
  }
  return [...byLower.values()].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
}

/** Read the newest version recorded in a CHANGELOG (first `## x.y.z` heading). */
export function newestChangelogVersion(changelog: string): string | null {
  for (const line of changelog.split("\n")) {
    const m = line.match(/^##\s+(\d+\.\d+\.\d+[^\s]*)\s*$/);
    if (m) return m[1];
  }
  return null;
}

// ───────────────────────────── impure / CI glue ─────────────────────────────

function git(args: string[], cwd: string = REPO_ROOT): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** Snapshot each package's current version before running `changeset version`. */
function readVersions(packageDirToName: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const dir of Object.keys(packageDirToName)) {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, dir, "package.json"), "utf8")) as {
      version?: string;
    };
    out[packageDirToName[dir]] = pkg.version ?? "";
  }
  return out;
}

function runChangesetVersion(): void {
  // Use the locally installed @changesets/cli bin via the package manager.
  // `vp dlx` resolves it from the workspace devDependency.
  console.log("[version] Running `changeset version`...");
  execFileSync("vp", ["dlx", "@changesets/cli", "version"], {
    cwd: REPO_ROOT,
    stdio: "inherit",
  });
}

/**
 * Resolve unique contributor logins for commits in `from..HEAD`, via the GitHub
 * API. Falls back to the commit author name when the API has no associated
 * GitHub user.
 *
 * @param from       git ref (prior tag)
 * @param repository "owner/repo"
 */
function resolveContributors(from: string, repository: string): string[] {
  let shas: string[] = [];
  try {
    shas = git(["log", `${from}..HEAD`, "--no-merges", "--format=%H"])
      .split("\n")
      .filter(Boolean);
  } catch {
    return [];
  }
  const logins: string[] = [];
  for (const sha of shas) {
    try {
      const login = execFileSync(
        "gh",
        [
          "api",
          `repos/${repository}/commits/${sha}`,
          "--jq",
          ".author.login // .commit.author.name",
        ],
        { cwd: REPO_ROOT, encoding: "utf8" },
      ).trim();
      if (login) logins.push(login);
    } catch {
      /* ignore individual failures */
    }
  }
  return dedupeSortLogins(logins);
}

function tagRefFor(pkgName: string, version: string): string {
  const scoped = `${pkgName}@${version}`;
  try {
    git(["rev-parse", "--verify", `${scoped}^{commit}`]);
    return scoped;
  } catch {
    return `v${version}`;
  }
}

function main(): void {
  const repository = process.env.GITHUB_REPOSITORY || "";
  const packageDirToName = discoverPublishablePackages();
  const before = readVersions(packageDirToName);

  runChangesetVersion();

  const after = readVersions(packageDirToName);

  for (const [dir, name] of Object.entries(packageDirToName)) {
    const oldVersion = before[name];
    const newVersion = after[name];
    if (!newVersion || newVersion === oldVersion) continue; // not bumped

    const changelogPath = join(REPO_ROOT, dir, "CHANGELOG.md");
    if (!existsSync(changelogPath)) {
      console.warn(`[version] ${name}: bumped but no CHANGELOG.md; skipping contributors.`);
      continue;
    }

    let contributors: string[] = [];
    if (repository) {
      const from = tagRefFor(name, oldVersion);
      contributors = resolveContributors(from, repository);
    } else {
      console.warn("[version] GITHUB_REPOSITORY unset; skipping contributor resolution.");
    }

    if (contributors.length === 0) {
      console.warn(`[version] ${name}: no contributors resolved; leaving CHANGELOG as-is.`);
      continue;
    }

    const original = readFileSync(changelogPath, "utf8");
    const updated = insertContributors(original, contributors);
    if (updated !== original) {
      writeFileSync(changelogPath, updated, "utf8");
      console.log(
        `[version] ${name}: appended ## Contributors (${contributors.length}) to ${dir}/CHANGELOG.md`,
      );
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
