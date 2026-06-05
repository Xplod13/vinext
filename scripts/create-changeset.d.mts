/**
 * Type declarations for scripts/create-changeset.mjs.
 *
 * The script is plain JS so it can be invoked directly via
 * `node scripts/create-changeset.mjs` from CI without a build step, but its
 * pure helpers are also imported from `scripts/create-changeset.test.ts`. These
 * declarations satisfy tsc / oxlint without flipping on checkJs / allowJs (which
 * would otherwise force tsc to type-check the `node:*` imports in the script
 * body). Mirrors the pattern in scripts/classify-nextjs-suites.d.mts.
 */

export type Bump = "major" | "minor" | "patch";

/** Conventional-Commit type → semver bump (`null` means "no release"). */
export const TYPE_BUMP: Record<string, "minor" | "patch" | null>;

/** Parse a Conventional-Commit subject (+ optional body) into a semver bump. */
export function parseBumpFromSubject(subject: string, body?: string): Bump | null;

/** Return the higher-precedence of two bumps (major > minor > patch). */
export function maxBump(a: Bump | null, b: Bump | null): Bump | null;

/** Map changed file paths to the publishable packages they belong to. */
export function affectedPackages(
  changedPaths: string[],
  packageDirToName: Record<string, string>,
): string[];

/** Compare two semver-ish strings (major.minor.patch). */
export function compareVersions(a: string, b: string): -1 | 0 | 1;

/** THE CORRECTNESS RULE: decide whether to generate changesets for a package. */
export function decideGeneration(
  pkgVersion: string,
  tagVersion: string | null,
): { action: "skip" | "generate"; reason: string };

/** Whether a commit subject is a changesets release/version-bump commit. */
export function isReleaseCommit(subject: string): boolean;

/** Render the combined changeset markdown from per-package bumps + commit lines. */
export function renderChangeset(pkgBumps: Record<string, Bump>, summaryLines: string[]): string;

/** Discover publishable workspace packages (repo-relative dir → package name). */
export function discoverPublishablePackages(root?: string): Record<string, string>;

/** Compute and write the auto changeset(s); returns a summary. */
export function run(): { written: string | null; bumps: Record<string, Bump> };
