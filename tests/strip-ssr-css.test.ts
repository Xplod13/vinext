/**
 * Focused unit tests for the `vinext:strip-ssr-css` transform.
 *
 * These tests exercise the pure transform helper directly, independent of
 * Vite/Rolldown. The integration coverage lives in `tests/ssr-css-assets.test.ts`
 * (which asserts the end-to-end "no dangling CSS references in SSR output"
 * invariant). The two layers are intentionally complementary: the integration
 * test catches regressions in either the plugin OR the `ssrEmitAssets: true`
 * config, while these unit tests pin down exactly which surface forms the
 * transform handles.
 */

import { describe, it, expect } from "vite-plus/test";
import { transformSsrCssReferences } from "../packages/vinext/src/plugins/strip-ssr-css.js";

describe("transformSsrCssReferences", () => {
  it("rewrites new URL('./x.css', import.meta.url) to a no-op data URL", () => {
    const result = transformSsrCssReferences(
      "/app/pages/api/url-dep.js",
      `console.log(new URL("./style.css", import.meta.url).href);
export default function handler(_req, res) { res.json({ ok: true }); }
`,
    );
    expect(result).not.toBeNull();
    expect(result!.code).toContain('new URL("data:,", import.meta.url)');
    expect(result!.code).not.toContain("./style.css");
  });

  it("handles single-quoted and template-string specifiers", () => {
    const result = transformSsrCssReferences(
      "/app/pages/api/url-dep.js",
      `const a = new URL('./a.css', import.meta.url);
const b = new URL(\`./b.css\`, import.meta.url);
`,
    );
    expect(result).not.toBeNull();
    expect(result!.code).not.toContain("./a.css");
    expect(result!.code).not.toContain("./b.css");
    // Both calls should be rewritten to the same `data:,` form.
    const matches = result!.code.match(/new URL\("data:,", import\.meta\.url\)/g);
    expect(matches?.length).toBe(2);
  });

  it("strips side-effect CSS imports", () => {
    const result = transformSsrCssReferences(
      "/app/components/server-component.tsx",
      `import "./styles.css";
export default function Component() { return null; }
`,
    );
    expect(result).not.toBeNull();
    expect(result!.code).not.toContain('"./styles.css"');
    expect(result!.code).not.toContain("import");
  });

  it('preserves `import "./x.css?url"` because it carries a string contract', () => {
    // `?url` imports return the resolved URL as a string. Removing the
    // import would break any module that subsequently reads from it via
    // side effects (or — in the bound form — by its binding).
    const code = `import "./styles.css?url";
export const X = 1;
`;
    const result = transformSsrCssReferences("/app/page.tsx", code);
    // No-op: returning null is also acceptable. Either way the `?url`
    // specifier must survive.
    if (result !== null) {
      expect(result.code).toContain("./styles.css?url");
    }
  });

  it("preserves `?raw`, `?inline`, and `?no-inline` query CSS imports", () => {
    for (const query of ["?raw", "?inline", "?no-inline"]) {
      const code = `import "./styles.css${query}";
`;
      const result = transformSsrCssReferences("/app/page.tsx", code);
      if (result !== null) {
        expect(result.code).toContain(`./styles.css${query}`);
      }
    }
  });

  it("does not rewrite modules whose own id carries a ?url/?raw/?inline query", () => {
    // The module being transformed is itself a `?url`-suffixed import. We
    // must not touch its body at all because the importer expects the raw
    // text content.
    const result = transformSsrCssReferences(
      "/app/components/server-component.tsx?url",
      `import "./styles.css";
new URL("./other.css", import.meta.url);
`,
    );
    expect(result).toBeNull();
  });

  it("returns null when the code contains no .css references", () => {
    const result = transformSsrCssReferences(
      "/app/components/server-component.tsx",
      `import { something } from "./helper.js";
export default function X() { return null; }
`,
    );
    expect(result).toBeNull();
  });

  it("rewrites both new URL and side-effect import in the same module", () => {
    const result = transformSsrCssReferences(
      "/app/page.tsx",
      `import "./globals.css";
const u = new URL("./fonts.css", import.meta.url);
export default function Page() { return null; }
`,
    );
    expect(result).not.toBeNull();
    expect(result!.code).not.toContain("./globals.css");
    expect(result!.code).not.toContain("./fonts.css");
    expect(result!.code).toContain('new URL("data:,", import.meta.url)');
  });

  it('does not touch bound imports like `import x from "./x.css"`', () => {
    // The side-effect regex is anchored to bare specifier imports only.
    // A bound default import would syntactically break if we removed it
    // (any subsequent reference to `styles` would fail). The bound form
    // is also very unusual in user code — Vite/Next.js libraries return a
    // CSS-modules object, not a default export.
    const code = `import styles from "./styles.css";
export default styles;
`;
    const result = transformSsrCssReferences("/app/page.tsx", code);
    expect(result).toBeNull();
  });

  it("preserves new URL specifiers that carry a ?url/?raw/?inline query", () => {
    // Symmetric with the side-effect import path: a `?url`-suffixed CSS
    // specifier in `new URL` is the user explicitly asking for the resolved
    // URL string. Rewriting it to `data:,` would lose information the
    // module body intends to consume.
    for (const query of ["?url", "?raw", "?inline", "?no-inline"]) {
      const code = `const u = new URL("./styles.css${query}", import.meta.url);
`;
      const result = transformSsrCssReferences("/app/page.tsx", code);
      if (result !== null) {
        expect(result.code).toContain(`./styles.css${query}`);
        expect(result.code).not.toContain("data:,");
      }
    }
  });

  it("only matches `.css` extensions, not other asset URLs", () => {
    const result = transformSsrCssReferences(
      "/app/page.tsx",
      `const a = new URL("./logo.png", import.meta.url);
const b = new URL("./worker.js", import.meta.url);
`,
    );
    expect(result).toBeNull();
  });
});
