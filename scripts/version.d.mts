/**
 * Type declarations for scripts/version.mjs.
 *
 * The script is plain JS so it can be invoked directly via
 * `node scripts/version.mjs` from CI (it shells out to `changeset version`,
 * `git`, and `gh`), but its pure CHANGELOG-rewrite helpers are imported from
 * `scripts/version.test.ts`. These declarations satisfy tsc / oxlint without
 * flipping on checkJs / allowJs. Mirrors scripts/classify-nextjs-suites.d.mts.
 */

/**
 * Insert (or replace) a `## Contributors` block at the END of the newest version
 * section of a CHANGELOG, leaving older sections untouched. Pure & idempotent.
 */
export function insertContributors(changelog: string, logins: string[]): string;

/** Normalize, dedupe (case-insensitive), and sort contributor logins. */
export function dedupeSortLogins(logins: string[]): string[];

/** Read the newest version recorded in a CHANGELOG (first `## x.y.z` heading). */
export function newestChangelogVersion(changelog: string): string | null;
