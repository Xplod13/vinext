#!/usr/bin/env node
/**
 * create-changeset.mjs — auto-generate Changesets from Conventional Commits.
 *
 * This is the ONLY bespoke "changeset authoring" surface in the release flow.
 * It runs in CI (see .github/workflows/release.yml) BEFORE `changesets/action`
 * and writes `.changeset/auto-*.md` into the working tree only. Those files are
 * never committed to `main`; the action consumes them into the rolling Version
 * PR and they are discarded.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE CORRECTNESS RULE (see CHANGESETS_MIGRATION_PLAN.md):
 *
 * To accumulate changes across many pushes WITHOUT persisting changesets on
 * `main`, this script regenerates the full unreleased set every run, from the
 * package's last release tag to HEAD, deterministically. That collides with the
 * publish trigger right after a Version PR merges, so we guard:
 *
 *   - If pkgVersion (in package.json) > lastTag version  → a release was merged
 *     but is not yet published. Generate NOTHING for that package, so the
 *     working tree has no changesets, the action no-ops on the PR, and the
 *     publish workflow does its job.
 *   - Else (pkgVersion == lastTag version)               → normal state.
 *     Generate changesets for commits in range v<pkgVersion>..HEAD.
 *
 * This makes the flow idempotent: every run recomputes from the tag, so the
 * Version PR is stable and accumulates correctly, and nothing is stored on main.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Decisions documented here (per the migration plan, author's discretion):
 *
 *   Conventional-Commit type → bump table (TYPE_BUMP below):
 *     feat            → minor
 *     fix             → patch
 *     perf            → patch
 *     revert          → patch   (a revert changes published behavior)
 *     refactor        → skip
 *     docs            → skip
 *     test            → skip
 *     ci              → skip
 *     build           → skip
 *     chore           → skip
 *     style           → skip
 *   Any of `feat!`, `fix!`, `<type>!`, or a `BREAKING CHANGE:` footer in the
 *   commit body → major (overrides the table). Unknown / non-conventional
 *   subjects → skip.
 *
 *   File naming: ONE COMBINED changeset file per run, named by the commit range
 *   it summarizes (`auto-<from>-<to>.md`, using short SHAs). A single file with
 *   one frontmatter entry per affected package keeps the working tree clean and
 *   trivially deterministic for a given range@HEAD. Packages get independent
 *   bumps via separate frontmatter lines, so multi-package generalizes for free.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

/**
 * Conventional-Commit type → semver bump. `null` means "no release".
 * @type {Record<string, "minor" | "patch" | null>}
 */
export const TYPE_BUMP = {
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

/** Bump precedence, highest first. @type {Array<"major"|"minor"|"patch">} */
const BUMP_ORDER = ["major", "minor", "patch"];

/**
 * Parse a Conventional-Commit subject (+ optional body) into a semver bump.
 *
 * @param {string} subject e.g. "feat(cache): add adapter (#1733)"
 * @param {string} [body]  full commit body, scanned for "BREAKING CHANGE"
 * @returns {"major" | "minor" | "patch" | null} bump, or null for no release
 */
export function parseBumpFromSubject(subject, body = "") {
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
 *
 * @param {"major"|"minor"|"patch"|null} a
 * @param {"major"|"minor"|"patch"|null} b
 * @returns {"major"|"minor"|"patch"|null}
 */
export function maxBump(a, b) {
  if (!a) return b ?? null;
  if (!b) return a ?? null;
  return BUMP_ORDER.indexOf(a) <= BUMP_ORDER.indexOf(b) ? a : b;
}

/**
 * Given a list of changed file paths (repo-relative, forward slashes) and a map
 * of packageDir → packageName, return the set of affected publishable package
 * names. A path is attributed to a package if it lives under that package's dir.
 *
 * @param {string[]} changedPaths
 * @param {Record<string, string>} packageDirToName  dir (repo-relative) → name
 * @returns {string[]} sorted unique affected package names
 */
export function affectedPackages(changedPaths, packageDirToName) {
  /** @type {Set<string>} */
  const affected = new Set();
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

/**
 * Compare two semver-ish strings (major.minor.patch, ignores prerelease).
 * @param {string} a
 * @param {string} b
 * @returns {-1 | 0 | 1}
 */
export function compareVersions(a, b) {
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
 * @param {string} pkgVersion version from package.json
 * @param {string | null} tagVersion version from the latest release tag, or null
 *        if the package has never been tagged
 * @returns {{ action: "skip" | "generate", reason: string }}
 *   - "skip": a release was merged but not yet published — generate nothing.
 *   - "generate": normal state — generate from the tag range.
 */
export function decideGeneration(pkgVersion, tagVersion) {
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
 * @param {string} subject
 * @returns {boolean}
 */
export function isReleaseCommit(subject) {
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
 * @param {Record<string, "major"|"minor"|"patch">} pkgBumps  name → bump
 * @param {string[]} summaryLines  one bullet per contributing commit
 * @returns {string} full file contents (frontmatter + body)
 */
export function renderChangeset(pkgBumps, summaryLines) {
  const names = Object.keys(pkgBumps).sort();
  const front = names.map((name) => `"${name}": ${pkgBumps[name]}`).join("\n");
  const body = summaryLines.length
    ? summaryLines.map((l) => `- ${l}`).join("\n")
    : "Automated changeset.";
  return `---\n${front}\n---\n\n${body}\n`;
}

// ───────────────────────────── impure / git glue ─────────────────────────────

/** @param {string[]} args @param {string} [cwd] */
function git(args, cwd = REPO_ROOT) {
  // Pipe stderr so expected failures (e.g. probing a tag that doesn't exist
  // before falling back) don't leak noisy `fatal:` lines into CI logs; callers
  // that care handle the thrown error.
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/**
 * Discover publishable workspace packages (non-private, has a version field).
 * Returns repo-relative dir → package name.
 * @returns {Record<string, string>}
 */
export function discoverPublishablePackages(root = REPO_ROOT) {
  /** @type {Record<string, string>} */
  const map = {};
  // Mirror pnpm-workspace globs at the granularity we need: scan the known
  // workspace roots for package.json files one level deep, plus fixtures.
  const workspaceRoots = ["packages", "apps", "examples", "benchmarks"];
  for (const wr of workspaceRoots) {
    const base = join(root, wr);
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const pkgJsonPath = join(base, entry.name, "package.json");
      if (!existsSync(pkgJsonPath)) continue;
      let pkg;
      try {
        pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
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
 * @param {string} pkgName
 * @returns {string | null}
 */
function latestTagVersion(pkgName) {
  let tags = [];
  try {
    tags = git(["tag", "-l"]).split("\n").filter(Boolean);
  } catch {
    return null;
  }
  /** @type {string[]} */
  const versions = [];
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
function tagRefFor(pkgName, tagVersion) {
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

/**
 * Read commits in `from..HEAD`, returning {sha, subject, body, files}.
 * @param {string} from git ref
 */
function commitsInRange(from) {
  // Use a record separator unlikely to appear in commit messages.
  const SEP = "␞"; // ␞
  const REC = "␟"; // ␟
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
    let files = [];
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

function shortSha(sha) {
  return String(sha).slice(0, 7);
}

/**
 * Main entry: compute and write the auto changeset(s). Returns a summary object
 * (also used to log). Does NOT throw on "nothing to do".
 */
export function run() {
  const changesetDir = join(REPO_ROOT, ".changeset");
  const packageDirToName = discoverPublishablePackages();
  const publishableNames = new Set(Object.values(packageDirToName));

  // Determine, per package, the generation decision and the diff range.
  /** @type {Map<string, { tagVersion: string|null, from: string }>} */
  const ranges = new Map();
  let anyGenerate = false;

  for (const [dir, name] of Object.entries(packageDirToName)) {
    const pkgJson = JSON.parse(readFileSync(join(REPO_ROOT, dir, "package.json"), "utf8"));
    const tagVersion = latestTagVersion(name);
    const decision = decideGeneration(pkgJson.version, tagVersion);
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

  // Walk the union of ranges. For a single global tag (today) all packages share
  // the same `from`; for multi-package each can differ. We aggregate per package.
  /** @type {Record<string, "major"|"minor"|"patch">} */
  const pkgBumps = {};
  /** @type {string[]} */
  const summaryLines = [];
  /** @type {Set<string>} */
  const seenCommits = new Set();
  let rangeLo = "";

  for (const [name, { from }] of ranges.entries()) {
    if (!rangeLo) rangeLo = from;
    const commits = commitsInRange(from);
    for (const commit of commits) {
      if (isReleaseCommit(commit.subject)) continue;
      const bump = parseBumpFromSubject(commit.subject, commit.body);
      if (!bump) continue;
      const affected = affectedPackages(commit.files, packageDirToName).filter((n) =>
        // Only attribute to this package within its own range walk.
        name ? n === name : publishableNames.has(n),
      );
      if (affected.length === 0) continue;
      for (const pkg of affected) {
        pkgBumps[pkg] = /** @type {any} */ (maxBump(pkgBumps[pkg] ?? null, bump));
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
  const hiSha = (() => {
    try {
      return shortSha(git(["rev-parse", "HEAD"]));
    } catch {
      return "head";
    }
  })();
  const loSha = rangeLo.replace(/[^a-zA-Z0-9._-]/g, "_");
  const fileName = `auto-${loSha}-${hiSha}.md`;
  const filePath = join(changesetDir, fileName);
  const contents = renderChangeset(pkgBumps, summaryLines);
  writeFileSync(filePath, contents, "utf8");
  console.log(`[create-changeset] Wrote ${relative(REPO_ROOT, filePath)}:`);
  console.log(contents);
  return { written: filePath, bumps: pkgBumps };
}

/** @returns {string} the very first commit in history (root). */
function firstCommit() {
  try {
    return git(["rev-list", "--max-parents=0", "HEAD"]).split("\n")[0].trim();
  } catch {
    return "HEAD~50";
  }
}

// Run when invoked directly (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  run();
}
