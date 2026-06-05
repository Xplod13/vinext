import { describe, expect, it } from "vite-plus/test";

import { dedupeSortLogins, insertContributors, newestChangelogVersion } from "./version.mjs";

describe("dedupeSortLogins", () => {
  it("strips @, dedupes case-insensitively, and sorts", () => {
    expect(dedupeSortLogins(["@bob", "Alice", "@alice", "bob", "carol"])).toEqual([
      "Alice",
      "bob",
      "carol",
    ]);
  });

  it("drops empties and non-strings", () => {
    // @ts-expect-error testing runtime robustness
    expect(dedupeSortLogins(["@x", "", "  ", null, undefined, 5])).toEqual(["x"]);
  });
});

describe("newestChangelogVersion", () => {
  it("returns the first version heading", () => {
    const cl = "# vinext\n\n## 0.1.0\n\n### Minor\n\n## 0.0.55\n";
    expect(newestChangelogVersion(cl)).toBe("0.1.0");
  });
  it("returns null when no version heading exists", () => {
    expect(newestChangelogVersion("# vinext\n")).toBeNull();
  });
});

describe("insertContributors", () => {
  const base = [
    "# vinext",
    "",
    "## 0.1.0",
    "",
    "### Minor Changes",
    "",
    "- feat: add cache adapter (#1733)",
    "",
    "## 0.0.55",
    "",
    "### Patch Changes",
    "",
    "- fix: earlier bug (#1)",
    "",
  ].join("\n");

  it("appends ## Contributors at the END of the newest section only", () => {
    const out = insertContributors(base, ["@bob", "@alice"]);
    const newestEnd = out.indexOf("## 0.0.55");
    const contribIdx = out.indexOf("## Contributors");
    // The block lands inside the newest section, before the older heading.
    expect(contribIdx).toBeGreaterThan(0);
    expect(contribIdx).toBeLessThan(newestEnd);
    expect(out).toContain("- @alice");
    expect(out).toContain("- @bob");
    // alice sorts before bob
    expect(out.indexOf("- @alice")).toBeLessThan(out.indexOf("- @bob"));
  });

  it("leaves the older section untouched", () => {
    const out = insertContributors(base, ["@bob"]);
    expect(out).toContain("## 0.0.55");
    expect(out).toContain("- fix: earlier bug (#1)");
    // Only one Contributors heading total.
    expect(out.match(/## Contributors/g)?.length).toBe(1);
  });

  it("is idempotent — re-running replaces, not stacks, the block", () => {
    const once = insertContributors(base, ["@bob", "@alice"]);
    const twice = insertContributors(once, ["@bob", "@alice", "@carol"]);
    expect(twice.match(/## Contributors/g)?.length).toBe(1);
    expect(twice).toContain("- @carol");
  });

  it("handles a changelog with only one (newest) section", () => {
    const single = ["# vinext", "", "## 0.1.0", "", "- feat: x (#9)", ""].join("\n");
    const out = insertContributors(single, ["@solo"]);
    expect(out).toContain("## Contributors");
    expect(out.trimEnd().endsWith("- @solo")).toBe(true);
  });

  it("returns input unchanged when there are no logins", () => {
    expect(insertContributors(base, [])).toBe(base);
  });

  it("returns input unchanged when there is no version section", () => {
    const noSection = "# vinext\n\nNothing released yet.\n";
    expect(insertContributors(noSection, ["@bob"])).toBe(noSection);
  });
});
