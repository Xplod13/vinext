/**
 * App Router CSS inlining (`experimental.inlineCss`).
 *
 * When the flag is enabled in `next.config`, vinext rewrites the
 * `<link rel="stylesheet" data-rsc-css-href="…">` tags that
 * `@vitejs/plugin-rsc` emits into the React tree to inline `<style>` blocks
 * containing the CSS file contents. This mirrors Next.js's
 * `experimental.inlineCss` behavior — see
 * https://nextjs.org/docs/app/api-reference/config/next-config-js/inlineCss
 * and `test/e2e/app-dir/app-inline-css/` in vercel/next.js.
 *
 * The lookup map is built once at server startup and exposed via
 * `globalThis.__VINEXT_INLINE_CSS_MAP__`. Two sources populate it:
 *
 *   1. Node prod server: walks `dist/client` at startup and reads each
 *      `.css` file into memory, keyed by the URL the RSC plugin will use
 *      (Vite's `base` + relative path). See `prod-server.ts`.
 *   2. Cloudflare Workers: the Vite plugin reads CSS contents from disk
 *      at build time and prepends a `globalThis.__VINEXT_INLINE_CSS_MAP__ = …`
 *      assignment to `dist/server/index.js`. See `index.ts`.
 *
 * Dev is a deliberate no-op — Next.js disables inlining in dev because HMR
 * keeps inserting/removing `<style>` nodes that conflict with the inlined
 * ones, and the e2e test that motivates this feature is itself gated to
 * production only.
 */

/**
 * Map of CSS asset URLs (e.g. `"/_next/static/foo.css"`) to file contents.
 * Returns `undefined` when no map has been registered — callers should
 * keep the original `<link rel="stylesheet">` tag in that case.
 */
export function getInlineCssMap(): Record<string, string> | undefined {
  return globalThis.__VINEXT_INLINE_CSS_MAP__;
}

/**
 * Register the inline CSS map. Used by the Node prod server (which builds
 * the map at startup) and by tests that want to seed a fake map.
 */
export function setInlineCssMap(map: Record<string, string> | undefined): void {
  if (map === undefined) {
    delete globalThis.__VINEXT_INLINE_CSS_MAP__;
  } else {
    globalThis.__VINEXT_INLINE_CSS_MAP__ = map;
  }
}

/**
 * Match the `<link rel="stylesheet" … data-rsc-css-href="…">` tags emitted
 * by `@vitejs/plugin-rsc`'s `Resources` component. The `data-rsc-css-href`
 * attribute is what we key the inline CSS map on — it's the URL the plugin
 * would normally use as the `href`. We deliberately match only tags that
 * carry the `data-rsc-css-href` marker so user-authored `<link rel="stylesheet">`
 * tags (e.g. for fonts) are left untouched.
 *
 * React Fizz serialises the tag as a self-closing void element, but defensive
 * code shouldn't assume self-closing — the regex tolerates both `/>` and `>`.
 */
const RSC_CSS_LINK_RE = /<link\s[^>]*\bdata-rsc-css-href="([^"]*)"[^>]*?\/?>/g;

/**
 * Decode the small subset of HTML entities React Fizz emits inside attribute
 * values (`&` and `"`). We deliberately do not try to be a full HTML decoder
 * here — only the entities React itself produces when serialising an attribute
 * value can show up in this position.
 */
function decodeRscCssHref(value: string): string {
  return value.replaceAll("&amp;", "&").replaceAll("&quot;", '"');
}

/**
 * Escape `</style>` and `</STYLE>` so user-authored CSS can't break out of the
 * inline `<style>` element. The CSS spec doesn't recognize `</style>` as a
 * comment terminator, but the HTML parser does — once it sees the closing
 * tag, everything after is parsed as HTML. The minimal mitigation is to
 * escape the `<` in `</style>` to `\3C` (the CSS-escape for `<`), which
 * leaves the rule grammar intact and the HTML tokenizer doesn't see a
 * matching tag. Case-insensitive because the HTML tokenizer is.
 *
 * See https://html.spec.whatwg.org/multipage/parsing.html#parse-error-end-tag-in-style
 */
function escapeStyleTagBoundary(css: string): string {
  // `<style>` itself can't appear meaningfully in CSS, but the same escape
  // rule applies and being symmetric keeps the substitution easier to audit.
  return css.replaceAll(/<\/(style)/gi, "<\\/$1");
}

/**
 * Rewrite a chunk of HTML so that every recognised RSC stylesheet link tag
 * becomes an inline `<style>` element using the contents from `map`. When
 * the URL is not present in `map` (e.g. a stale entry, a third-party CSS,
 * or no map was registered) the link tag is left in place — the page still
 * works, just without the inlining optimisation.
 */
export function rewriteRscCssLinksToInline(
  html: string,
  map: Record<string, string> | undefined,
): string {
  if (!map) return html;
  return html.replace(RSC_CSS_LINK_RE, (match, hrefAttr: string) => {
    const href = decodeRscCssHref(hrefAttr);
    const css = map[href];
    if (css === undefined) return match;
    return `<style data-vinext-inline-css="${hrefAttr}">${escapeStyleTagBoundary(css)}</style>`;
  });
}

/**
 * Create a transform stream that inlines RSC CSS link tags as `<style>`
 * blocks using the registered inline CSS map. When no map is registered
 * (dev, or `experimental.inlineCss` disabled) this is the identity transform
 * — bytes pass through unchanged.
 *
 * The transform decodes the chunk to UTF-8 with `{ stream: true }` and
 * buffers each tick's output until the chunk ends with a complete `>`. In
 * the unlikely event the React renderer splits a `<link …>` tag across two
 * chunks, the partial tag is held until the rest of the tag arrives — the
 * regex would otherwise fail to match a tag whose `data-rsc-css-href`
 * attribute lands in the next chunk.
 */
export function createInlineCssTransform(): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending = "";

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      const map = getInlineCssMap();
      const text = pending + decoder.decode(chunk, { stream: true });
      if (!map) {
        // Map registered as undefined → pass-through. Still flush any
        // pending bytes from a previous chunk before the map cleared.
        if (text) controller.enqueue(encoder.encode(text));
        pending = "";
        return;
      }
      // Hold the chunk back when it ends inside a tag — the regex below
      // can only match a complete `<link … data-rsc-css-href="…" …>` and
      // we'd otherwise emit a half-tag that the next pass would already
      // have rewritten.
      const lastOpen = text.lastIndexOf("<");
      const lastClose = text.lastIndexOf(">");
      let emit: string;
      if (lastOpen > lastClose) {
        emit = text.slice(0, lastOpen);
        pending = text.slice(lastOpen);
      } else {
        emit = text;
        pending = "";
      }
      const rewritten = rewriteRscCssLinksToInline(emit, map);
      if (rewritten) controller.enqueue(encoder.encode(rewritten));
    },
    flush(controller) {
      if (!pending) return;
      const map = getInlineCssMap();
      const out = rewriteRscCssLinksToInline(pending, map);
      pending = "";
      controller.enqueue(encoder.encode(out));
    },
  });
}
