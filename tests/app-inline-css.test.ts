/**
 * Unit tests for the HTML stream transform that powers
 * `experimental.inlineCss`. Validates the rewrite-only rules in isolation
 * from the SSR pipeline so we can be confident about:
 *
 *   - User-authored `<link rel="stylesheet">` (e.g. fonts) is untouched.
 *   - The RSC-emitted `<link rel="stylesheet" data-rsc-css-href="…">` is
 *     replaced with an inline `<style>` block when the URL is in the map.
 *   - An unknown URL is left as a `<link>` (graceful degradation).
 *   - The transform is a pass-through when no map is registered.
 *   - CSS contents that contain `</style>` cannot break out of the tag.
 *
 * See `packages/vinext/src/server/app-inline-css.ts` for the implementation.
 */

import { afterEach, describe, it, expect } from "vite-plus/test";
import {
  createInlineCssTransform,
  rewriteRscCssLinksToInline,
  setInlineCssMap,
} from "../packages/vinext/src/server/app-inline-css.js";

/**
 * Drive the transform with one or more pre-encoded chunks. Splitting input
 * across chunks exercises the cross-chunk tag-buffering codepath — the
 * transform must hold partial `<link …>` openings until a chunk completes
 * the tag, otherwise the regex misses the rewrite and we'd silently emit
 * the original `<link rel="stylesheet">`.
 */
async function runTransform(
  chunks: string | string[],
  nonce?: string,
  options?: { prependCss?: string; fallbackHTML?: string },
): Promise<string> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const transform = createInlineCssTransform(nonce, options);
  const writer = transform.writable.getWriter();
  const reader = transform.readable.getReader();
  const out: string[] = [];

  const readPromise = (async (): Promise<void> => {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      out.push(decoder.decode(value));
    }
  })();

  const list = Array.isArray(chunks) ? chunks : [chunks];
  for (const piece of list) {
    await writer.write(encoder.encode(piece));
  }
  await writer.close();
  await readPromise;

  return out.join("");
}

describe("rewriteRscCssLinksToInline", () => {
  it("replaces RSC stylesheet links with <style> blocks using the map", () => {
    const html =
      `<head><link rel="stylesheet" precedence="vite-rsc/importer-resources" ` +
      `href="/_next/static/foo.css" data-rsc-css-href="/_next/static/foo.css"/></head>`;
    const map = { "/_next/static/foo.css": "p { color: red; }" };
    const out = rewriteRscCssLinksToInline(html, map);
    expect(out.html).toContain('<style data-vinext-inline-css="/_next/static/foo.css">');
    expect(out.html).toContain("p { color: red; }");
    expect(out.html).not.toContain('<link rel="stylesheet"');
    expect(out.consumedPrependCss).toBe(false);
  });

  it("emits nonce on the inlined <style> tag when provided", () => {
    // Without a nonce, sites that ship `Content-Security-Policy:
    // style-src 'nonce-…'` see the inlined block blocked at parse time
    // and render unstyled. The `<link>` tag the feature replaces wasn't
    // subject to the same rule, so the nonce has to land on the new
    // `<style>` to preserve parity.
    const html = `<link rel="stylesheet" data-rsc-css-href="/x.css" href="/x.css"/>`;
    const out = rewriteRscCssLinksToInline(html, { "/x.css": "a {}" }, "abc123");
    expect(out.html).toContain('<style data-vinext-inline-css="/x.css" nonce="abc123">');
  });

  it("looks up CSS by URL pathname when assetPrefix yields an absolute URL", () => {
    // With `assetPrefix: "https://cdn.example.com"`, the RSC plugin emits a
    // fully-qualified URL in `data-rsc-css-href`. The map is keyed by the
    // path portion (matching the on-disk relative path under dist/client),
    // so the lookup needs to try both forms.
    const html =
      `<link rel="stylesheet" ` +
      `data-rsc-css-href="https://cdn.example.com/_next/static/foo.css" ` +
      `href="https://cdn.example.com/_next/static/foo.css"/>`;
    const map = { "/_next/static/foo.css": "p { color: blue; }" };
    const out = rewriteRscCssLinksToInline(html, map);
    expect(out.html).toContain("<style");
    expect(out.html).toContain("p { color: blue; }");
    expect(out.html).not.toContain("<link");
  });

  it("leaves user-authored stylesheet links (no data-rsc-css-href) alone", () => {
    const html = `<head><link rel="stylesheet" href="https://fonts/foo.css"/></head>`;
    const out = rewriteRscCssLinksToInline(html, { "/_next/static/foo.css": "x" });
    expect(out.html).toBe(html);
  });

  it("leaves the link tag when the URL is not in the map", () => {
    const html =
      `<link rel="stylesheet" href="/_next/static/missing.css" ` +
      `data-rsc-css-href="/_next/static/missing.css"/>`;
    const out = rewriteRscCssLinksToInline(html, { "/_next/static/other.css": "x" });
    expect(out.html).toBe(html);
  });

  it("is a no-op when no map is provided", () => {
    const html = `<link rel="stylesheet" data-rsc-css-href="/x.css" href="/x.css"/>`;
    expect(rewriteRscCssLinksToInline(html, undefined).html).toBe(html);
  });

  it("escapes </style> inside CSS contents to prevent tag breakout", () => {
    const evil = "p::before { content: '</style><script>x</script>'; }";
    const html = `<link rel="stylesheet" data-rsc-css-href="/x.css" href="/x.css"/>`;
    const out = rewriteRscCssLinksToInline(html, { "/x.css": evil }).html;
    // The hostile `</style>` from the source CSS must have been escaped.
    expect(out).toContain("<\\/style>");
    // Only one literal `</style>` is left — the one that closes our
    // injected block. A second un-escaped occurrence would mean the
    // injected `<script>` payload could escape into HTML.
    expect(out.match(/<\/style>/g)?.length).toBe(1);
    // Sanity check: the `<script>` text from the CSS is now inside our
    // single, contiguous `<style>…</style>` element (it lies between the
    // opening tag and the closing one).
    const open = out.indexOf("<style");
    const close = out.indexOf("</style>");
    expect(open).toBeGreaterThanOrEqual(0);
    expect(close).toBeGreaterThan(open);
    expect(out.slice(open, close)).toContain("<script");
  });

  it("decodes the &amp; entity in the data-rsc-css-href attribute", () => {
    // Vite hrefs don't normally contain `&`, but if React Fizz serialises
    // any future tag with one we still need to look up by the decoded URL.
    const html = `<link rel="stylesheet" data-rsc-css-href="/a.css?x=1&amp;y=2" href="/a.css?x=1&amp;y=2"/>`;
    const out = rewriteRscCssLinksToInline(html, { "/a.css?x=1&y=2": "z" }).html;
    expect(out).toContain("<style");
    expect(out).toContain(">z</style>");
  });

  it("does not double-unescape entities in the href attribute", () => {
    // Regression for CodeQL "Double escaping or unescaping". An input like
    // `&amp;quot;` is the *literal* text `&quot;` with `&` escaped — naive
    // chained replaceAll() would collapse it to `"`. The single-pass decode
    // must leave `&quot;` intact.
    const html = `<link rel="stylesheet" data-rsc-css-href="/a.css?q=&amp;quot;" href="/a.css?q=&amp;quot;"/>`;
    const out = rewriteRscCssLinksToInline(html, { "/a.css?q=&quot;": "y" }).html;
    expect(out).toContain("<style");
    expect(out).toContain(">y</style>");
    expect(out).not.toContain('data-vinext-inline-css="/a.css?q=&quot;');
  });

  it("prepends prependCss into the first rewritten <style>", () => {
    const html =
      `<link rel="stylesheet" data-rsc-css-href="/a.css" href="/a.css"/>` +
      `<link rel="stylesheet" data-rsc-css-href="/b.css" href="/b.css"/>`;
    const map = { "/a.css": ".a {}", "/b.css": ".b {}" };
    const out = rewriteRscCssLinksToInline(html, map, undefined, "@font-face { src: u; }");
    expect(out.consumedPrependCss).toBe(true);
    // Font CSS rides inside the first inlined style, not the second.
    const firstStyleOpen = out.html.indexOf("<style");
    const firstStyleClose = out.html.indexOf("</style>");
    expect(out.html.slice(firstStyleOpen, firstStyleClose)).toContain("@font-face");
    expect(out.html.slice(firstStyleClose)).not.toContain("@font-face");
  });

  it("skips the prepend when the CSS opens with @import or @namespace", () => {
    // CSS imports must stay first-byte; prepending font CSS in front would
    // silently invalidate the import. Caller is expected to fall back to a
    // standalone <style data-vinext-fonts> when consumedPrependCss=false.
    const html = `<link rel="stylesheet" data-rsc-css-href="/a.css" href="/a.css"/>`;
    const map = { "/a.css": "@import url('/reset.css'); .a {}" };
    const out = rewriteRscCssLinksToInline(html, map, undefined, "@font-face { src: u; }");
    expect(out.consumedPrependCss).toBe(false);
    expect(out.html).not.toContain("@font-face");
    expect(out.html).toContain("@import url('/reset.css');");
  });
});

describe("createInlineCssTransform", () => {
  afterEach(() => setInlineCssMap(undefined));

  it("rewrites complete tags in a single chunk", async () => {
    setInlineCssMap({ "/x.css": "a {}" });
    const html = `<head><link rel="stylesheet" data-rsc-css-href="/x.css" href="/x.css"/></head>`;
    const out = await runTransform(html);
    expect(out).toContain("<style");
    expect(out).toContain("a {}");
    expect(out).not.toContain("<link");
  });

  it("is a pass-through when no map is registered", async () => {
    const html = `<link rel="stylesheet" data-rsc-css-href="/x.css" href="/x.css"/>`;
    expect(await runTransform(html)).toBe(html);
  });

  it("forwards the SSR nonce onto the inlined <style> tag", async () => {
    setInlineCssMap({ "/x.css": "a {}" });
    const html = `<link rel="stylesheet" data-rsc-css-href="/x.css" href="/x.css"/>`;
    const out = await runTransform(html, "nonce-abc");
    expect(out).toContain('nonce="nonce-abc"');
    expect(out).toContain("<style");
  });

  it("rewrites a tag that React Fizz split across two chunks", async () => {
    // The transform buffers the open angle bracket until the closing `>`
    // arrives in a later chunk — otherwise the regex would see just
    // `<link rel="stylesheet" data-r` and miss the rewrite.
    setInlineCssMap({ "/x.css": "a {}" });
    const before = `<head><link rel="stylesheet" data-rsc-`;
    const after = `css-href="/x.css" href="/x.css"/></head>`;
    const out = await runTransform([before, after]);
    expect(out).toContain("<style");
    expect(out).toContain("a {}");
    expect(out).not.toContain("<link");
  });

  it("merges font CSS into the first inlined <style> via prependCss", async () => {
    setInlineCssMap({ "/a.css": ".page { color: yellow; }" });
    const html =
      `<html><head>` +
      `<link rel="stylesheet" data-rsc-css-href="/a.css" href="/a.css"/>` +
      `</head><body></body></html>`;
    const out = await runTransform(html, undefined, {
      prependCss: "@font-face { font-family: f; src: url('/f.woff2'); }",
      fallbackHTML: "<style data-vinext-fonts>FALLBACK</style>",
    });
    // Font CSS rides inside the first inline-css <style> block.
    const open = out.indexOf("<style data-vinext-inline-css");
    const close = out.indexOf("</style>", open);
    expect(open).toBeGreaterThanOrEqual(0);
    expect(out.slice(open, close)).toContain("@font-face");
    expect(out.slice(open, close)).toContain(".page { color: yellow; }");
    // Fallback was suppressed — no standalone <style data-vinext-fonts>.
    expect(out).not.toContain("FALLBACK");
  });

  it("emits the fallback when no stylesheet link gets inlined", async () => {
    // Page has zero `data-rsc-css-href` links, so no `<style>` is emitted
    // for the page CSS. The font CSS still needs to land in <head> — the
    // transform injects the fallback right before </head>.
    setInlineCssMap({});
    const html = `<html><head><meta charset="utf-8"/></head><body>x</body></html>`;
    const out = await runTransform(html, undefined, {
      prependCss: "@font-face { font-family: f; src: url('/f.woff2'); }",
      fallbackHTML: "<style data-vinext-fonts>F</style>",
    });
    const fallbackIdx = out.indexOf("<style data-vinext-fonts>F</style>");
    const headCloseIdx = out.indexOf("</head>");
    expect(fallbackIdx).toBeGreaterThanOrEqual(0);
    // Fallback must land before </head>, not after.
    expect(fallbackIdx).toBeLessThan(headCloseIdx);
  });

  it("skips fallback when the page CSS preamble is import-sensitive", async () => {
    // The inlined CSS starts with `@import`, so prepending font CSS would
    // invalidate the import. The transform must keep the inline link
    // rewrite but still fall back to the standalone font style tag.
    setInlineCssMap({ "/a.css": "@import url('/r.css'); .a {}" });
    const html =
      `<html><head>` +
      `<link rel="stylesheet" data-rsc-css-href="/a.css" href="/a.css"/>` +
      `</head><body></body></html>`;
    const out = await runTransform(html, undefined, {
      prependCss: "@font-face { font-family: f; src: url('/f.woff2'); }",
      fallbackHTML: "<style data-vinext-fonts>F</style>",
    });
    // Inline rewrite still happened…
    expect(out).toContain("<style data-vinext-inline-css");
    expect(out).toContain("@import url('/r.css');");
    // …but the font CSS did NOT get prepended into it.
    const open = out.indexOf("<style data-vinext-inline-css");
    const close = out.indexOf("</style>", open);
    expect(out.slice(open, close)).not.toContain("@font-face");
    // And the fallback DID land before </head>.
    const fallbackIdx = out.indexOf("<style data-vinext-fonts>F</style>");
    const headCloseIdx = out.indexOf("</head>");
    expect(fallbackIdx).toBeGreaterThan(close);
    expect(fallbackIdx).toBeLessThan(headCloseIdx);
  });
});
