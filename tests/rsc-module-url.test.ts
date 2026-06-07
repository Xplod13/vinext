import { describe, expect, it } from "vitest";

import { resolveRscModuleUrl } from "../packages/vinext/src/utils/rsc-module-url.js";

describe("resolveRscModuleUrl", () => {
  const root = "/project";

  it("prefers the live module URL from the HMR context", () => {
    const url = resolveRscModuleUrl(
      "/project/app/page.tsx",
      [{ url: "/app/page.tsx?t=123" }],
      root,
    );
    expect(url).toBe("/app/page.tsx?t=123");
  });

  it("skips empty/nullish module URLs and uses the first valid one", () => {
    const url = resolveRscModuleUrl(
      "/project/app/page.tsx",
      [{ url: null }, { url: "" }, { url: "/app/page.tsx" }],
      root,
    );
    expect(url).toBe("/app/page.tsx");
  });

  it("falls back to a root-relative URL when no module survives in the graph", () => {
    // This is the recovery case: after a transform error the module dropped out
    // of the rsc graph, so `modules` is empty.
    const url = resolveRscModuleUrl("/project/app/foo/bar.tsx", [], root);
    expect(url).toBe("/app/foo/bar.tsx");
  });

  it("uses the /@fs/ form for files outside the project root", () => {
    const url = resolveRscModuleUrl("/elsewhere/lib/x.tsx", [], root);
    expect(url).toBe("/@fs/elsewhere/lib/x.tsx");
  });

  it("normalizes Windows-style separators to posix URLs", () => {
    const url = resolveRscModuleUrl("C:\\project\\app\\page.tsx", [], "C:\\project");
    expect(url).toBe("/app/page.tsx");
  });
});
