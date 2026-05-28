/**
 * styled-jsx CSS minification at JSX transform time.
 *
 * Next.js's compiler (SWC/Babel) ships a styled-jsx pass that rewrites
 * `<style jsx>` into a `JSXStyle` element with already-minified CSS.
 * vinext's OXC JSX transform does not, so without intervention the
 * template literal flows through to React verbatim and the SSR HTML
 * contains the developer's original `\n p {\n   color: blue;\n }`
 * formatting — failing Next.js's streaming-ssr regression which expects
 * the canonical `color:blue` (no-space) match.
 *
 * The vinext styled-jsx plugin pre-transforms source so the literal is
 * minified before the JSX transform runs.
 *
 * Mirrors Next.js: test/e2e/streaming-ssr/index.test.ts
 * https://github.com/vercel/next.js/blob/canary/test/e2e/streaming-ssr/index.test.ts
 *
 * Closes: https://github.com/cloudflare/vinext/issues/1556
 */

import { describe, it, expect } from "vite-plus/test";
import { styledJsxPlugin, minifyStyledJsxCss } from "../packages/vinext/src/plugins/styled-jsx.js";

type TransformFn = (code: string, id: string) => null | { code: string; map: null } | undefined;

function getTransform(): TransformFn {
  const plugin = styledJsxPlugin() as { transform: TransformFn };
  return plugin.transform.bind(plugin);
}

describe("minifyStyledJsxCss", () => {
  it("collapses the canonical `p { color: blue; }` shape to minified form", () => {
    const out = minifyStyledJsxCss("\n        p {\n          color: blue;\n        }\n      ");
    expect(out).toBe("p{color:blue}");
  });

  it("handles multiple rules and selectors", () => {
    const out = minifyStyledJsxCss(`
      p { color: red; }
      .x, .y { margin: 0; padding: 0; }
    `);
    expect(out).toBe("p{color:red}.x,.y{margin:0;padding:0}");
  });

  it("strips /* … */ comments before collapsing whitespace", () => {
    const out = minifyStyledJsxCss(`
      /* this is a comment */
      a { color: blue; }
    `);
    expect(out).toBe("a{color:blue}");
  });

  it("preserves a single space between value tokens that need separation", () => {
    const out = minifyStyledJsxCss(`
      div { margin: 1px 2px 3px 4px; }
    `);
    expect(out).toBe("div{margin:1px 2px 3px 4px}");
  });
});

describe("vinext:styled-jsx transform", () => {
  it("minifies the CSS inside <style jsx>{`...`}</style> blocks", () => {
    const transform = getTransform();
    const source = [
      "export default function Page() {",
      "  return (",
      "    <div>",
      "      <style jsx>{`",
      "        p {",
      "          color: blue;",
      "        }",
      "      `}</style>",
      "      <p>index</p>",
      "    </div>",
      "  );",
      "}",
    ].join("\n");

    const result = transform(source, "/project/pages/index.tsx");
    expect(result).not.toBeNull();
    // The rewritten source must contain the minified rule so the canonical
    // Next.js streaming-ssr match `/color:(?:blue|#00f)/` succeeds at SSR.
    expect(result?.code).toMatch(/color:blue/);
    // The boolean `jsx` flag is stripped so React does not warn about an
    // unknown DOM attribute on the rendered <style> element.
    expect(result?.code).not.toMatch(/<style[^>]*\bjsx\b/);
    // Source structure outside the literal is preserved.
    expect(result?.code).toContain("<p>index</p>");
  });

  it("also handles `<style jsx global>`", () => {
    const transform = getTransform();
    const source = "const x = <style jsx global>{`body { margin: 0; }`}</style>;\n";
    const result = transform(source, "/project/pages/index.tsx");
    expect(result?.code).toContain("body{margin:0}");
    expect(result?.code).not.toMatch(/\bjsx\b/);
    expect(result?.code).not.toMatch(/\bglobal\b/);
  });

  it("leaves <style> tags without the `jsx` flag untouched", () => {
    const transform = getTransform();
    // `<style jsx` hint is not present, so the cheap pre-check short-circuits.
    const source = "const x = <style>{`body { margin: 0; }`}</style>;\n";
    const result = transform(source, "/project/pages/index.tsx");
    expect(result).toBeNull();
  });

  it("skips files outside JSX-capable extensions", () => {
    const transform = getTransform();
    const source = "<style jsx>{`p { color: blue; }`}</style>";
    expect(transform(source, "/project/styles.css")).toBeNull();
    expect(transform(source, "/project/notes.md")).toBeNull();
  });

  it("skips node_modules sources (library code is already compiled)", () => {
    const transform = getTransform();
    const source = "<style jsx>{`p { color: blue; }`}</style>";
    expect(transform(source, "/project/node_modules/lib/index.jsx")).toBeNull();
  });

  it("returns null when no <style jsx> block is present", () => {
    const transform = getTransform();
    expect(transform("export default function P() { return null; }", "/a.tsx")).toBeNull();
  });
});
