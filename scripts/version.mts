#!/usr/bin/env node
/**
 * `changeset version` + a grouped, conventional-commits changelog with a bottom
 * `## Contributors` list. Used as the `version:` command for `changesets/action`
 * (see .github/workflows/release.yml).
 *
 * Changesets' default changelog groups by bump level (Minor/Patch Changes), not
 * by commit type, and has no end-of-release contributor hook. So after running
 * `changeset version` we rewrite each bumped package's newest CHANGELOG section:
 * the release commits are regrouped into `### Features` / `### Bug Fixes` / etc.
 * and a deduped, bot-filtered `## Contributors` list is appended. The pure
 * builders (groupedChangelogBody, rewriteReleaseSection, dedupeSortLogins) are
 * unit-tested; the git/gh glue is CI-only.
 *
 * Runs on Node >=24 via native type stripping: `node scripts/version.mts`.
 * Env: GITHUB_TOKEN (for `gh api`), GITHUB_REPOSITORY ("owner/repo").
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  type Commit,
  collectReleaseCommits,
  conventionalParts,
  discoverPublishablePackages,
  tagRefFor,
} from "./create-changeset.mts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

/** Conventional-commit type → changelog section heading, in render order. */
const GROUPS: { type: string; heading: string }[] = [
  { type: "feat", heading: "Features" },
  { type: "fix", heading: "Bug Fixes" },
  { type: "perf", heading: "Performance" },
  { type: "revert", heading: "Reverts" },
];

/** Group release commits into `### <Heading>` sections; scope rendered in bold. */
export function groupedChangelogBody(commits: Commit[]): string {
  const buckets = new Map<string, string[]>();
  for (const c of commits) {
    const parts = conventionalParts(c.subject);
    if (!parts) continue;
    const line = parts.scope
      ? `- **${parts.scope}:** ${parts.description}`
      : `- ${parts.description}`;
    (buckets.get(parts.type) ?? buckets.set(parts.type, []).get(parts.type) ?? []).push(line);
  }
  const known = new Set(GROUPS.map((g) => g.type));
  const sections = GROUPS.filter((g) => buckets.get(g.type)?.length).map(
    (g) => `### ${g.heading}\n\n${buckets.get(g.type)!.join("\n")}`,
  );
  const other = [...buckets].filter(([t]) => !known.has(t)).flatMap(([, l]) => l);
  if (other.length) sections.push(`### Other Changes\n\n${other.join("\n")}`);
  return sections.join("\n\n");
}

/**
 * Replace the body of the newest `## <version>` section with `body`, then append
 * a `## Contributors` list. Older sections are untouched. Only `## <digit>`
 * counts as a section boundary, so re-running is idempotent. Pure.
 */
export function rewriteReleaseSection(
  changelog: string,
  body: string,
  contributors: string[],
): string {
  const lines = changelog.split("\n");
  const isVersionHeading = (l: string) => /^##\s+\d/.test(l);
  const start = lines.findIndex(isVersionHeading);
  if (start === -1) return changelog;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (isVersionHeading(lines[i])) {
      end = i;
      break;
    }
  }

  const block = [lines[start]]; // the `## <version>` heading
  if (body.trim()) block.push("", body);
  const logins = dedupeSortLogins(contributors);
  if (logins.length) block.push("", "## Contributors", "", ...logins.map((l) => `- @${l}`));
  block.push("");

  const rebuilt = [...lines.slice(0, start), ...block, ...lines.slice(end)].join("\n");
  return `${rebuilt.replace(/\n{3,}/g, "\n\n").replace(/\s+$/, "")}\n`;
}

/** Strip leading `@`, drop empties and `[bot]` accounts, dedupe (ci) and sort. */
export function dedupeSortLogins(logins: string[]): string[] {
  const byLower = new Map<string, string>();
  for (const raw of logins ?? []) {
    if (typeof raw !== "string") continue;
    const login = raw.trim().replace(/^@+/, "");
    if (!login || /\[bot\]$/i.test(login)) continue;
    if (!byLower.has(login.toLowerCase())) byLower.set(login.toLowerCase(), login);
  }
  return [...byLower.values()].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
}

// ───────────────────────────── CI glue ─────────────────────────────

function git(args: string[], cwd: string = REPO_ROOT): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function readVersions(packageDirToName: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [dir, name] of Object.entries(packageDirToName)) {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, dir, "package.json"), "utf8")) as {
      version?: string;
    };
    out[name] = pkg.version ?? "";
  }
  return out;
}

/** GitHub contributor logins for `from..HEAD` (bots filtered by dedupeSortLogins). */
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

function main(): void {
  const repository = process.env.GITHUB_REPOSITORY || "";
  const packages = discoverPublishablePackages();
  const before = readVersions(packages);

  console.log("[version] Running `changeset version`...");
  execFileSync("vp", ["dlx", "@changesets/cli", "version"], { cwd: REPO_ROOT, stdio: "inherit" });

  const after = readVersions(packages);

  for (const [dir, name] of Object.entries(packages)) {
    if (!after[name] || after[name] === before[name]) continue; // not bumped
    const changelogPath = join(REPO_ROOT, dir, "CHANGELOG.md");
    if (!existsSync(changelogPath)) {
      console.warn(`[version] ${name}: bumped but no CHANGELOG.md; skipping rewrite.`);
      continue;
    }

    const from = tagRefFor(name, before[name]);
    const body = groupedChangelogBody(collectReleaseCommits(from, name, packages));
    const contributors = repository ? resolveContributors(from, repository) : [];

    const original = readFileSync(changelogPath, "utf8");
    const updated = rewriteReleaseSection(original, body, contributors);
    if (updated !== original) {
      writeFileSync(changelogPath, updated, "utf8");
      console.log(`[version] ${name}: grouped changelog + ${contributors.length} contributors.`);
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
