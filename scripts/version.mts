#!/usr/bin/env node
/**
 * `changeset version` + a bottom `## Contributors` list. Used as the `version:`
 * command for `changesets/action` (see .github/workflows/release.yml).
 *
 * Runs `changeset version` (consumes changesets, bumps versions, writes
 * CHANGELOGs, cascades internal deps), then for each bumped package appends a
 * deduped `## Contributors` block to the end of its newest CHANGELOG.md section.
 * Changesets has no native hook for an end-of-release contributor list, hence
 * this wrapper. insertContributors is pure + unit-tested; the rest is CI glue.
 *
 * Runs on Node >=24 via native type stripping: `node scripts/version.mts`.
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
 * Append (replacing any existing) a `## Contributors` block at the end of the
 * NEWEST `## <version>` section, leaving older sections untouched. A
 * `## Contributors` heading is not a section boundary, so re-running replaces
 * rather than stacks. Pure; returns input unchanged if no section / no logins.
 */
export function insertContributors(changelog: string, logins: string[]): string {
  const cleaned = dedupeSortLogins(logins);
  if (cleaned.length === 0) return changelog;

  const lines = changelog.split("\n");
  const isVersionHeading = (l: string) => /^##\s+/.test(l) && !/^##\s+Contributors\s*$/i.test(l);

  const start = lines.findIndex((l) => /^##\s+/.test(l));
  if (start === -1) return changelog;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (isVersionHeading(lines[i])) {
      end = i;
      break;
    }
  }

  // Newest section, with any prior Contributors block stripped and trailing
  // blanks trimmed, then the fresh block appended.
  let section = lines.slice(start, end);
  const contribIdx = section.findIndex((l) => /^##\s+Contributors\s*$/i.test(l));
  if (contribIdx !== -1) section = section.slice(0, contribIdx);
  while (section.length > 0 && section[section.length - 1].trim() === "") section.pop();
  section.push("", "## Contributors", "", ...cleaned.map((l) => `- @${l}`));

  const after = lines.slice(end);
  const joinedAfter = after.length > 0 && after[0].trim() !== "" ? ["", ...after] : after;
  return [...lines.slice(0, start), ...section, ...joinedAfter].join("\n");
}

/** Strip leading `@`, drop empties, dedupe case-insensitively, sort. */
export function dedupeSortLogins(logins: string[]): string[] {
  const byLower = new Map<string, string>();
  for (const raw of logins ?? []) {
    if (typeof raw !== "string") continue;
    const login = raw.trim().replace(/^@+/, "");
    if (login && !byLower.has(login.toLowerCase())) byLower.set(login.toLowerCase(), login);
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

/** Unique contributor logins for `from..HEAD`, via the GitHub API. */
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

/** Prior tag ref for a package: prefer scoped `<name>@<version>`, else `v<version>`. */
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
  const packages = discoverPublishablePackages();
  const before = readVersions(packages);

  console.log("[version] Running `changeset version`...");
  execFileSync("vp", ["dlx", "@changesets/cli", "version"], { cwd: REPO_ROOT, stdio: "inherit" });

  const after = readVersions(packages);

  for (const [dir, name] of Object.entries(packages)) {
    if (!after[name] || after[name] === before[name]) continue; // not bumped
    const changelogPath = join(REPO_ROOT, dir, "CHANGELOG.md");
    if (!existsSync(changelogPath)) {
      console.warn(`[version] ${name}: bumped but no CHANGELOG.md; skipping contributors.`);
      continue;
    }
    if (!repository) {
      console.warn("[version] GITHUB_REPOSITORY unset; skipping contributor resolution.");
      continue;
    }
    const contributors = resolveContributors(tagRefFor(name, before[name]), repository);
    if (contributors.length === 0) {
      console.warn(`[version] ${name}: no contributors resolved; leaving CHANGELOG as-is.`);
      continue;
    }
    const original = readFileSync(changelogPath, "utf8");
    const updated = insertContributors(original, contributors);
    if (updated !== original) {
      writeFileSync(changelogPath, updated, "utf8");
      console.log(`[version] ${name}: appended ## Contributors (${contributors.length}).`);
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
