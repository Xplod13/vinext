#!/usr/bin/env node
/**
 * Auto-generate Changesets from Conventional Commits. The only bespoke
 * "changeset authoring" surface in the release flow. Runs in CI before
 * `changesets/action` (see .github/workflows/release.yml) and writes
 * `.changeset/auto-*.md` into the working tree only — never committed to `main`;
 * the action consumes them into the Version PR and they are discarded.
 *
 * Runs directly on Node >=24 via native type stripping: `node scripts/create-changeset.mts`.
 *
 * THE CORRECTNESS RULE: to accumulate across pushes without persisting changesets
 * on `main`, we regenerate the full unreleased set every run, from each package's
 * last release tag to HEAD. That would collide with the publish trigger right
 * after a Version PR merges, so decideGeneration() skips a package whose
 * package.json version is already ahead of its latest tag (release merged,
 * awaiting publish) — leaving the working tree empty so the action publishes
 * instead of re-opening a PR. Recomputing from the tag each run is idempotent.
 *
 * Type → bump: feat→minor; fix/perf/revert→patch; everything else→skip;
 * any `<type>!` or `BREAKING CHANGE:` footer→major (overrides the table).
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

const BUMP_ORDER: Bump[] = ["major", "minor", "patch"];

/** Parse a Conventional-Commit subject (+ body, scanned for BREAKING CHANGE). */
export function parseBumpFromSubject(subject: string, body = ""): Bump | null {
  if (typeof subject !== "string") return null;
  const match = subject.match(/^([a-zA-Z]+)(?:\(([^)]*)\))?(!)?:\s/);
  if (!match) return null;
  const type = match[1].toLowerCase();
  const breaking = match[3] === "!" || /(^|\n)\s*BREAKING[ -]CHANGE[:!]/.test(body);
  if (breaking) return "major";
  if (!(type in TYPE_BUMP)) return null;
  return TYPE_BUMP[type];
}

/** Higher-precedence of two bumps (major > minor > patch); null = no bump. */
export function maxBump(a: Bump | null, b: Bump | null): Bump | null {
  if (!a) return b ?? null;
  if (!b) return a ?? null;
  return BUMP_ORDER.indexOf(a) <= BUMP_ORDER.indexOf(b) ? a : b;
}

/** Affected publishable package names for the given changed paths, sorted. */
export function affectedPackages(
  changedPaths: string[],
  packageDirToName: Record<string, string>,
): string[] {
  const affected = new Set<string>();
  // Longest dir first so nested packages match before their ancestors.
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

/** Compare semver-ish strings (major.minor.patch, ignores prerelease). */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const parse = (v: string) => v.split(/[.+-]/).map((n) => Number.parseInt(n, 10) || 0);
  const pa = parse(String(a));
  const pb = parse(String(b));
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

/** THE CORRECTNESS RULE, as a pure function. See the file header. */
export function decideGeneration(
  pkgVersion: string,
  tagVersion: string | null,
): { action: "skip" | "generate"; reason: string } {
  if (tagVersion == null) return { action: "generate", reason: "no release tag yet" };
  if (compareVersions(pkgVersion, tagVersion) > 0) {
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

/** A version/release bump commit that must never produce a changeset. */
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

/** Build the combined changeset file (frontmatter + bullet body). Pure. */
export function renderChangeset(pkgBumps: Record<string, Bump>, summaryLines: string[]): string {
  const front = Object.keys(pkgBumps)
    .sort()
    .map((name) => `"${name}": ${pkgBumps[name]}`)
    .join("\n");
  const body = summaryLines.length
    ? summaryLines.map((l) => `- ${l}`).join("\n")
    : "Automated changeset.";
  return `---\n${front}\n---\n\n${body}\n`;
}

// ───────────────────────────── git / fs glue ─────────────────────────────

function git(args: string[], cwd: string = REPO_ROOT): string {
  // Pipe stderr so expected probe failures (e.g. a missing tag) don't leak
  // `fatal:` noise into CI logs; callers that care handle the thrown error.
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

type PackageJson = { name?: string; version?: string; private?: boolean };

/** Publishable workspace packages (non-private, versioned): repo-relative dir → name. */
export function discoverPublishablePackages(root: string = REPO_ROOT): Record<string, string> {
  const map: Record<string, string> = {};
  for (const wr of ["packages", "apps", "examples", "benchmarks"]) {
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
      if (pkg.private === true || !pkg.name || !pkg.version) continue;
      map[relative(root, join(base, entry.name)).replace(/\\/g, "/")] = pkg.name;
    }
  }
  return map;
}

/**
 * Latest release tag version for a package. Accepts both the legacy global
 * `v<version>` and changesets' `<name>@<version>` scheme; picks the highest.
 */
function latestTagVersion(pkgName: string): string | null {
  let tags: string[] = [];
  try {
    tags = git(["tag", "-l"]).split("\n").filter(Boolean);
  } catch {
    return null;
  }
  const scopedPrefix = `${pkgName}@`;
  const versions = tags
    .map((tag) =>
      tag.startsWith(scopedPrefix)
        ? tag.slice(scopedPrefix.length)
        : /^v\d+\.\d+\.\d+/.test(tag)
          ? tag.slice(1)
          : null,
    )
    .filter((v): v is string => v != null)
    .sort(compareVersions);
  return versions.at(-1) ?? null;
}

/** Git ref to diff from: prefer the scoped tag, else the global `v<version>`. */
function tagRefFor(pkgName: string, tagVersion: string): string {
  const scoped = `${pkgName}@${tagVersion}`;
  try {
    git(["rev-parse", "--verify", `${scoped}^{commit}`]);
    return scoped;
  } catch {
    return `v${tagVersion}`;
  }
}

type Commit = { sha: string; subject: string; body: string; files: string[] };

/** Commits in `from..HEAD` with their changed files. */
function commitsInRange(from: string): Commit[] {
  const FIELD = "␞";
  const REC = "␟";
  let raw = "";
  try {
    raw = git(["log", `${from}..HEAD`, "--no-merges", `--format=${REC}%H${FIELD}%s${FIELD}%b`]);
  } catch {
    return [];
  }
  return raw
    .split(REC)
    .filter((r) => r.trim().length > 0)
    .map((rec) => {
      const [sha, subject, body = ""] = rec.split(FIELD);
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

function firstCommit(): string {
  try {
    return git(["rev-list", "--max-parents=0", "HEAD"]).split("\n")[0].trim();
  } catch {
    return "HEAD~50";
  }
}

/** Compute and write the auto changeset. Returns a summary; never throws on no-op. */
export function run(): { written: string | null; bumps: Record<string, Bump> } {
  const packageDirToName = discoverPublishablePackages();

  // Per-package: decide generate-vs-skip and the diff range.
  const ranges = new Map<string, string>(); // name → `from` ref
  for (const [dir, name] of Object.entries(packageDirToName)) {
    const pkg = JSON.parse(
      readFileSync(join(REPO_ROOT, dir, "package.json"), "utf8"),
    ) as PackageJson;
    const tagVersion = latestTagVersion(name);
    const decision = decideGeneration(pkg.version ?? "0.0.0", tagVersion);
    console.log(`[create-changeset] ${name}: ${decision.action} — ${decision.reason}`);
    if (decision.action === "generate") {
      ranges.set(name, tagVersion ? tagRefFor(name, tagVersion) : firstCommit());
    }
  }
  if (ranges.size === 0) {
    console.log("[create-changeset] Nothing to generate (guard active for all packages).");
    return { written: null, bumps: {} };
  }

  // Walk each package's range; a commit only counts toward the package it owns.
  const pkgBumps: Record<string, Bump> = {};
  const summaryLines: string[] = [];
  const seen = new Set<string>();
  let rangeLo = "";
  for (const [name, from] of ranges) {
    if (!rangeLo) rangeLo = from;
    for (const commit of commitsInRange(from)) {
      if (isReleaseCommit(commit.subject)) continue;
      const bump = parseBumpFromSubject(commit.subject, commit.body);
      if (!bump) continue;
      if (!affectedPackages(commit.files, packageDirToName).includes(name)) continue;
      const merged = maxBump(pkgBumps[name] ?? null, bump);
      if (merged) pkgBumps[name] = merged;
      if (!seen.has(commit.sha)) {
        seen.add(commit.sha);
        summaryLines.push(commit.subject);
      }
    }
  }
  if (Object.keys(pkgBumps).length === 0) {
    console.log("[create-changeset] No release-worthy commits in range.");
    return { written: null, bumps: {} };
  }

  let hiSha = "head";
  try {
    hiSha = git(["rev-parse", "HEAD"]).slice(0, 7);
  } catch {
    /* keep fallback */
  }
  const loSha = rangeLo.replace(/[^a-zA-Z0-9._-]/g, "_");
  const filePath = join(REPO_ROOT, ".changeset", `auto-${loSha}-${hiSha}.md`);
  const contents = renderChangeset(pkgBumps, summaryLines);
  writeFileSync(filePath, contents, "utf8");
  console.log(`[create-changeset] Wrote ${relative(REPO_ROOT, filePath)}:\n${contents}`);
  return { written: filePath, bumps: pkgBumps };
}

if (import.meta.url === `file://${process.argv[1]}`) run();
