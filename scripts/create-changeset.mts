#!/usr/bin/env node
/**
 * create-changeset.mts — auto-generate Changesets from Conventional Commits.
 *
 * This is the ONLY bespoke "changeset authoring" surface in the release flow.
 * It runs in CI (see .github/workflows/release.yml) BEFORE `changesets/action`
 * and writes `.changeset/auto-*.md` into the working tree only. Those files are
 * never committed to `main`; the action consumes them into the rolling Version
 * PR and they are discarded.
 *
 * Run directly on Node (>=24, which strips types natively):
 *   node scripts/create-changeset.mts
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE CORRECTNESS RULE:
 *
 * To accumulate changes across many pushes WITHOUT persisting changesets on
 * `main`, this script regenerates the full unreleased set every run, from the
 * package's last release tag to HEAD, deterministically. That collides with the
 * publish trigger right after a Version PR merges, so we guard:
 *
 *   - If pkgVersion (in package.json) > lastTag version  → a release was merged
 *     but is not yet published. Generate NOTHING for that package, so the
 *     working tree has no changesets, the action no-ops on the PR, and the
 *     publish step runs.
 *   - Else (pkgVersion == lastTag version)               → normal state.
 *     Generate changesets for commits in range v<pkgVersion>..HEAD.
 *
 * This makes the flow idempotent: every run recomputes from the tag, so the
 * Version PR is stable and accumulates correctly, and nothing is stored on main.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Conventional-Commit type → bump table (TYPE_BUMP below):
 *     feat → minor; fix/perf/revert → patch; refactor/docs/test/ci/build/chore/
 *     style → skip. Any `<type>!` or a `BREAKING CHANGE:` footer → major
 *     (overrides the table). Unknown / non-conventional subjects → skip.
 *
 * File naming: ONE COMBINED changeset file per run, named by the commit range it
 * summarizes (`auto-<from>-<to>.md`). A single file with one frontmatter entry
 * per affected package keeps the working tree clean and deterministic for a
 * given range@HEAD; multi-package generalizes via separate frontmatter lines.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type Bump = "major" | "minor" | "patch";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

/** Conventional-Commit type → semver bump. `null` means "no release". */
export const TYPE_BUMP: Record<string, Bump | null> = {
  feat: "minor",
  fix: "patch",
  perf: "patch",
  revert: "patch",
  refactor: null,
  docs: null,
  test: null,
  ci: null,
  build: null,
  chore: null,
  style: null,
};

/** Bump precedence, highest first. */
const BUMP_ORDER: Bump[] = ["major", "minor", "patch"];

/**
 * Parse a Conventional-Commit subject (+ optional body) into a semver bump.
 *
 * @param subject e.g. "feat(cache): add adapter (#1733)"
 * @param body    full commit body, scanned for "BREAKING CHANGE"
 * @returns bump, or null for no release
 */
export function parseBumpFromSubject(subject: string, body = ""): Bump | null {
  if (typeof subject !== "string") return null;
  // Conventional Commit header: type(optional-scope)(optional !): description
  const match = subject.match(/^([a-zA-Z]+)(?:\(([^)]*)\))?(!)?:\s/);
  if (!match) return null;

  const type = match[1].toLowerCase();
  const bang = match[3] === "!";

  // A breaking change always wins, regardless of type.
  const breakingFooter = /(^|\n)\s*BREAKING[ -]CHANGE[:!]/.test(body);
  if (bang || breakingFooter) return "major";

  if (!(type in TYPE_BUMP)) return null;
  return TYPE_BUMP[type];
}

/**
 * Return the higher-precedence of two bumps (major > minor > patch). `null`
 * means "no bump"; the non-null value wins, or null if both are null.
 */
export function maxBump(a: Bump | null, b: Bump | null): Bump | null {
  if (!a) return b ?? null;
  if (!b) return a ?? null;
  return BUMP_ORDER.indexOf(a) <= BUMP_ORDER.indexOf(b) ? a : b;
}

/**
 * Given a list of changed file paths (repo-relative, forward slashes) and a map
 * of packageDir → packageName, return the set of affected publishable package
 * names. A path is attributed to a package if it lives under that package's dir.
 *
 * @returns sorted unique affected package names
 */
export function affectedPackages(
  changedPaths: string[],
  packageDirToName: Record<string, string>,
): string[] {
  const affected = new Set<string>();
  // Longest dir first so nested packages are matched before ancestors.
  const dirs = Object.keys(packageDirToName).sort((a, b) => b.length - a.length);
  for (const path of changedPaths) {
    const norm = path.replace(/\\/g, "/");
    for (const dir of dirs) {
      const prefix = dir === "." ? "" : `${dir.replace(/\/$/, "")}/`;
      if (prefix === "" || norm.startsWith(prefix)) {
        affected.add(packageDirToName[dir]);
        break;
      }
    }
  }
  return [...affected].sort();
}

/** Compare two semver-ish strings (major.minor.patch, ignores prerelease). */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const pa = String(a)
    .split(/[.+-]/)
    .map((n) => Number.parseInt(n, 10) || 0);
  const pb = String(b)
    .split(/[.+-]/)
    .map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

/**
 * THE CORRECTNESS RULE, as a pure function.
 *
 * @param pkgVersion version from package.json
 * @param tagVersion version from the latest release tag, or null if never tagged
 * @returns "skip" (a release was merged but not yet published — generate
 *   nothing) or "generate" (normal state — generate from the tag range).
 */
export function decideGeneration(
  pkgVersion: string,
  tagVersion: string | null,
): { action: "skip" | "generate"; reason: string } {
  if (tagVersion == null) {
    // Never released: treat as normal, generate from the start of history.
    return { action: "generate", reason: "no release tag yet" };
  }
  const cmp = compareVersions(pkgVersion, tagVersion);
  if (cmp > 0) {
    return {
      action: "skip",
      reason: `package.json (${pkgVersion}) > tag (${tagVersion}); release merged, awaiting publish`,
    };
  }
  return {
    action: "generate",
    reason: `package.json (${pkgVersion}) == tag (${tagVersion}); accumulating unreleased commits`,
  };
}

/**
 * Detect whether a commit subject is a version/release bump commit that should
 * never produce a changeset (changesets' default release commit, or our own).
 */
export function isReleaseCommit(subject: string): boolean {
  const s = String(subject).trim().toLowerCase();
  return (
    s === "version packages" ||
    s.startsWith("chore: version packages") ||
    s.startsWith("ci(changesets): version packages") ||
    s.startsWith("rc:") ||
    s.startsWith("chore(release):")
  );
}

/**
 * Build the combined changeset markdown body from per-package bumps and the
 * contributing commit lines. Pure: no I/O.
 *
 * @param pkgBumps     name → bump
 * @param summaryLines one bullet per contributing commit
 * @returns full file contents (frontmatter + body)
 */
export function renderChangeset(pkgBumps: Record<string, Bump>, summaryLines: string[]): string {
  const names = Object.keys(pkgBumps).sort();
  const front = names.map((name) => `"${name}": ${pkgBumps[name]}`).join("\n");
  const body = summaryLines.length
    ? summaryLines.map((l) => `- ${l}`).join("\n")
    : "Automated changeset.";
  return `---\n${front}\n---\n\n${body}\n`;
}

// ───────────────────────────── impure / git glue ─────────────────────────────

function git(args: string[], cwd: string = REPO_ROOT): string {
  // Pipe stderr so expected failures (e.g. probing a tag that doesn't exist
  // before falling back) don't leak noisy `fatal:` lines into CI logs; callers
  // that care handle the thrown error.
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

type PackageJson = {
  name?: string;
  version?: string;
  private?: boolean;
};

/**
 * Discover publishable workspace packages (non-private, has a version field).
 * Returns repo-relative dir → package name.
 */
export function discoverPublishablePackages(root: string = REPO_ROOT): Record<string, string> {
  const map: Record<string, string> = {};
  // Mirror pnpm-workspace globs at the granularity we need: scan the known
  // workspace roots for package.json files one level deep.
  const workspaceRoots = ["packages", "apps", "examples", "benchmarks"];
  for (const wr of workspaceRoots) {
    const base = join(root, wr);
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const pkgJsonPath = join(base, entry.name, "package.json");
      if (!existsSync(pkgJsonPath)) continue;
      let pkg: PackageJson;
      try {
        pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as PackageJson;
      } catch {
        continue;
      }
      // Publishable = not private AND has a name AND has a version.
      if (pkg.private === true) continue;
      if (!pkg.name || !pkg.version) continue;
      const dir = relative(root, join(base, entry.name)).replace(/\\/g, "/");
      map[dir] = pkg.name;
    }
  }
  return map;
}

/**
 * Resolve the latest release tag version for a package. Today tags are global
 * `v<version>` (single package). For multi-package readiness we also accept
 * `<name>@<version>` tags and pick the highest matching version.
 */
function latestTagVersion(pkgName: string): string | null {
  let tags: string[] = [];
  try {
    tags = git(["tag", "-l"]).split("\n").filter(Boolean);
  } catch {
    return null;
  }
  const versions: string[] = [];
  const scopedPrefix = `${pkgName}@`;
  for (const tag of tags) {
    if (tag.startsWith(scopedPrefix)) {
      versions.push(tag.slice(scopedPrefix.length));
    } else if (/^v\d+\.\d+\.\d+/.test(tag)) {
      versions.push(tag.slice(1));
    }
  }
  if (versions.length === 0) return null;
  versions.sort(compareVersions);
  return versions[versions.length - 1];
}

/** Resolve the git ref to diff from, given a package's tag version. */
function tagRefFor(pkgName: string, tagVersion: string): string {
  // Prefer a scoped tag if it exists; else the global v<version>.
  const scoped = `${pkgName}@${tagVersion}`;
  try {
    git(["rev-parse", "--verify", `${scoped}^{commit}`]);
    return scoped;
  } catch {
    /* fall through */
  }
  return `v${tagVersion}`;
}

type Commit = {
  sha: string;
  subject: string;
  body: string;
  files: string[];
};

/** Read commits in `from..HEAD`, returning {sha, subject, body, files}. */
function commitsInRange(from: string): Commit[] {
  // Use record/field separators unlikely to appear in commit messages.
  const SEP = "␞";
  const REC = "␟";
  let raw = "";
  try {
    raw = git(["log", `${from}..HEAD`, "--no-merges", `--format=${REC}%H${SEP}%s${SEP}%b`]);
  } catch {
    return [];
  }
  if (!raw) return [];
  const records = raw.split(REC).filter((r) => r.trim().length > 0);
  return records.map((rec) => {
    const [sha, subject, body = ""] = rec.split(SEP);
    let files: string[] = [];
    try {
      files = git(["show", "--name-only", "--format=", sha.trim()])
        .split("\n")
        .map((f) => f.trim())
        .filter(Boolean);
    } catch {
      /* ignore */
    }
    return { sha: sha.trim(), subject: (subject || "").trim(), body: body || "", files };
  });
}

function shortSha(sha: string): string {
  return String(sha).slice(0, 7);
}

/** @returns the very first commit in history (root). */
function firstCommit(): string {
  try {
    return git(["rev-list", "--max-parents=0", "HEAD"]).split("\n")[0].trim();
  } catch {
    return "HEAD~50";
  }
}

/**
 * Main entry: compute and write the auto changeset(s). Returns a summary object
 * (also used to log). Does NOT throw on "nothing to do".
 */
export function run(): { written: string | null; bumps: Record<string, Bump> } {
  const changesetDir = join(REPO_ROOT, ".changeset");
  const packageDirToName = discoverPublishablePackages();

  // Determine, per package, the generation decision and the diff range.
  const ranges = new Map<string, { tagVersion: string | null; from: string }>();
  let anyGenerate = false;

  for (const [dir, name] of Object.entries(packageDirToName)) {
    const pkgJson = JSON.parse(
      readFileSync(join(REPO_ROOT, dir, "package.json"), "utf8"),
    ) as PackageJson;
    const tagVersion = latestTagVersion(name);
    const decision = decideGeneration(pkgJson.version ?? "0.0.0", tagVersion);
    console.log(`[create-changeset] ${name}: ${decision.action} — ${decision.reason}`);
    if (decision.action === "skip") continue;
    anyGenerate = true;
    const from = tagVersion ? tagRefFor(name, tagVersion) : firstCommit();
    ranges.set(name, { tagVersion, from });
  }

  if (!anyGenerate) {
    console.log("[create-changeset] Nothing to generate (guard active for all packages).");
    return { written: null, bumps: {} };
  }

  // Walk each package's range and aggregate per-package bumps. For a single
  // global tag (today) all packages share the same `from`; multi-package may
  // differ. A commit only counts toward the package whose range walk it is in.
  const pkgBumps: Record<string, Bump> = {};
  const summaryLines: string[] = [];
  const seenCommits = new Set<string>();
  let rangeLo = "";

  for (const [name, { from }] of ranges.entries()) {
    if (!rangeLo) rangeLo = from;
    for (const commit of commitsInRange(from)) {
      if (isReleaseCommit(commit.subject)) continue;
      const bump = parseBumpFromSubject(commit.subject, commit.body);
      if (!bump) continue;
      const affected = affectedPackages(commit.files, packageDirToName).filter((n) => n === name);
      if (affected.length === 0) continue;
      for (const pkg of affected) {
        const merged = maxBump(pkgBumps[pkg] ?? null, bump);
        if (merged) pkgBumps[pkg] = merged;
      }
      if (!seenCommits.has(commit.sha)) {
        seenCommits.add(commit.sha);
        summaryLines.push(commit.subject);
      }
    }
  }

  if (Object.keys(pkgBumps).length === 0) {
    console.log("[create-changeset] No release-worthy commits in range.");
    return { written: null, bumps: {} };
  }

  // Deterministic file name for this range@HEAD.
  let hiSha = "head";
  try {
    hiSha = shortSha(git(["rev-parse", "HEAD"]));
  } catch {
    /* keep fallback */
  }
  const loSha = rangeLo.replace(/[^a-zA-Z0-9._-]/g, "_");
  const fileName = `auto-${loSha}-${hiSha}.md`;
  const filePath = join(changesetDir, fileName);
  const contents = renderChangeset(pkgBumps, summaryLines);
  writeFileSync(filePath, contents, "utf8");
  console.log(`[create-changeset] Wrote ${relative(REPO_ROOT, filePath)}:`);
  console.log(contents);
  return { written: filePath, bumps: pkgBumps };
}

// Run when invoked directly (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  run();
}
