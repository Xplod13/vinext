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
async function runTransform(chunks: string | string[], nonce?: string): Promise<string> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const transform = createInlineCssTransform(nonce);
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
    expect(out).toContain('<style data-vinext-inline-css="/_next/static/foo.css">');
    expect(out).toContain("p { color: red; }");
    expect(out).not.toContain('<link rel="stylesheet"');
  });

  it("emits nonce on the inlined <style> tag when provided", () => {
    // Without a nonce, sites that ship `Content-Security-Policy:
    // style-src 'nonce-…'` see the inlined block blocked at parse time
    // and render unstyled. The `<link>` tag the feature replaces wasn't
    // subject to the same rule, so the nonce has to land on the new
    // `<style>` to preserve parity.
    const html = `<link rel="stylesheet" data-rsc-css-href="/x.css" href="/x.css"/>`;
    const out = rewriteRscCssLinksToInline(html, { "/x.css": "a {}" }, "abc123");
    expect(out).toContain('<style data-vinext-inline-css="/x.css" nonce="abc123">');
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
    expect(out).toContain("<style");
    expect(out).toContain("p { color: blue; }");
    expect(out).not.toContain("<link");
  });

  it("leaves user-authored stylesheet links (no data-rsc-css-href) alone", () => {
    const html = `<head><link rel="stylesheet" href="https://fonts/foo.css"/></head>`;
    const out = rewriteRscCssLinksToInline(html, { "/_next/static/foo.css": "x" });
    expect(out).toBe(html);
  });

  it("leaves the link tag when the URL is not in the map", () => {
    const html =
      `<link rel="stylesheet" href="/_next/static/missing.css" ` +
      `data-rsc-css-href="/_next/static/missing.css"/>`;
    const out = rewriteRscCssLinksToInline(html, { "/_next/static/other.css": "x" });
    expect(out).toBe(html);
  });

  it("is a no-op when no map is provided", () => {
    const html = `<link rel="stylesheet" data-rsc-css-href="/x.css" href="/x.css"/>`;
    expect(rewriteRscCssLinksToInline(html, undefined)).toBe(html);
  });

  it("escapes </style> inside CSS contents to prevent tag breakout", () => {
    const evil = "p::before { content: '</style><script>x</script>'; }";
    const html = `<link rel="stylesheet" data-rsc-css-href="/x.css" href="/x.css"/>`;
    const out = rewriteRscCssLinksToInline(html, { "/x.css": evil });
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
    const out = rewriteRscCssLinksToInline(html, { "/a.css?x=1&y=2": "z" });
    expect(out).toContain("<style");
    expect(out).toContain(">z</style>");
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
});
