import { describe, expect, it } from "vite-plus/test";

import type { Commit } from "./create-changeset.mts";
import { dedupeSortLogins, groupedChangelogBody, rewriteReleaseSection } from "./version.mts";

const commit = (subject: string): Commit => ({ sha: subject, subject, body: "", files: [] });

describe("dedupeSortLogins", () => {
  it("strips @, dedupes case-insensitively, and sorts", () => {
    expect(dedupeSortLogins(["@bob", "Alice", "@alice", "bob", "carol"])).toEqual([
      "Alice",
      "bob",
      "carol",
    ]);
  });

  it("drops empties, non-strings, and [bot] accounts", () => {
    // @ts-expect-error testing runtime robustness
    expect(dedupeSortLogins(["@x", "", "  ", null, undefined, 5, "dependabot[bot]"])).toEqual([
      "x",
    ]);
  });
});

describe("groupedChangelogBody", () => {
  const commits = [
    commit("feat(cache): add adapter (#1733)"),
    commit("fix(link): correct prefetch (#1734)"),
    commit("feat: top-level feature (#1)"),
    commit("perf(rsc): faster transport (#2)"),
    commit("chore: noise"), // non-release type → ignored
  ];

  it("groups by type under conventional headings, in order", () => {
    const out = groupedChangelogBody(commits);
    expect(out.indexOf("### Features")).toBeGreaterThanOrEqual(0);
    expect(out.indexOf("### Features")).toBeLessThan(out.indexOf("### Bug Fixes"));
    expect(out.indexOf("### Bug Fixes")).toBeLessThan(out.indexOf("### Performance"));
  });

  it("bolds the scope and drops the type prefix; bare commits have no scope", () => {
    const out = groupedChangelogBody(commits);
    expect(out).toContain("- **cache:** add adapter (#1733)");
    expect(out).toContain("- top-level feature (#1)");
    expect(out).not.toContain("feat(cache)");
  });

  it("omits empty sections and chore noise", () => {
    const out = groupedChangelogBody([commit("fix: only a fix")]);
    expect(out).toContain("### Bug Fixes");
    expect(out).not.toContain("### Features");
    expect(out).not.toContain("noise");
  });
});

describe("rewriteReleaseSection", () => {
  const base = [
    "# vinext",
    "",
    "## 0.1.0",
    "",
    "### Minor Changes",
    "",
    "- - feat: raw changeset dump",
    "",
    "## 0.0.55",
    "",
    "### Patch Changes",
    "",
    "- fix: earlier bug (#1)",
    "",
  ].join("\n");

  const body = "### Features\n\n- **cache:** add adapter (#1733)";

  it("replaces the newest section body and appends Contributors, leaving older sections", () => {
    const out = rewriteReleaseSection(base, body, ["@bob", "@alice"]);
    expect(out).toContain("### Features");
    expect(out).not.toContain("Minor Changes"); // raw dump replaced
    expect(out).toContain("## Contributors");
    expect(out.indexOf("- @alice")).toBeLessThan(out.indexOf("- @bob"));
    // older section untouched
    expect(out).toContain("## 0.0.55");
    expect(out).toContain("- fix: earlier bug (#1)");
  });

  it("is idempotent — only `## <digit>` is a section boundary", () => {
    const once = rewriteReleaseSection(base, body, ["@bob"]);
    const twice = rewriteReleaseSection(once, body, ["@bob", "@carol"]);
    expect(twice.match(/## Contributors/g)?.length).toBe(1);
    expect(twice.match(/## 0\.0\.55/g)?.length).toBe(1);
    expect(twice).toContain("- @carol");
  });

  it("returns input unchanged when there is no version section", () => {
    const noSection = "# vinext\n\nNothing released yet.\n";
    expect(rewriteReleaseSection(noSection, body, ["@bob"])).toBe(noSection);
  });
});
