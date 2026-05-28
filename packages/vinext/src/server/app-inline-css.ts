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
import { createNonceAttribute, escapeHtmlAttr } from "./html.js";

/**
 * Map of CSS asset URLs (e.g. `"/_next/static/foo.css"`) to file contents.
 * Returns `undefined` when no map has been registered — callers should
 * keep the original `<link rel="stylesheet">` tag in that case.
 */
function getInlineCssMap(): Record<string, string> | undefined {
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
 *
 * Single-pass: chaining `.replaceAll("&amp;", "&").replaceAll("&quot;", '"')`
 * double-unescapes `&amp;quot;` (literal `&quot;`) to `"`, which CodeQL flagged
 * as a "Double escaping or unescaping" pattern. A single regex with a callback
 * runs each character at most once and leaves unknown entities untouched.
 */
const RSC_CSS_HREF_ENTITY_RE = /&(amp|quot);/g;
const RSC_CSS_HREF_ENTITY_MAP: Record<string, string> = { amp: "&", quot: '"' };
function decodeRscCssHref(value: string): string {
  return value.replace(
    RSC_CSS_HREF_ENTITY_RE,
    (_match, name: string) => RSC_CSS_HREF_ENTITY_MAP[name] ?? _match,
  );
}

/**
 * Normalise the URL the RSC plugin put in `data-rsc-css-href` to a key that
 * could appear in our map. We always store keys as the on-disk relative
 * path with a leading slash (`/_next/static/foo.css`). When `assetPrefix`
 * is configured as an absolute URL (e.g. `https://cdn.example.com`), the
 * plugin emits a fully-qualified URL and the bare-path lookup would miss
 * — so we yield both the original string *and* the path portion so callers
 * can probe in order. Path-prefix assetPrefix (`/cdn/_next/static/foo.css`)
 * works without normalisation because the on-disk layout matches the URL
 * 1-for-1.
 */
function inlineCssMapKeyCandidates(href: string): string[] {
  // Cheap fast-path: bare paths are the common case.
  if (href.startsWith("/")) return [href];
  // `https://…/_next/static/foo.css` → also try `/_next/static/foo.css`.
  try {
    const url = new URL(href);
    return [href, url.pathname];
  } catch {
    return [href];
  }
}

/**
 * Escape `</style>` and `</STYLE>` so user-authored CSS can't break out of
 * the inline `<style>` element. The CSS spec doesn't recognize `</style>`
 * as a comment terminator, but the HTML parser does — once it sees the
 * closing tag, everything after is parsed as HTML. The minimal mitigation
 * is to insert a backslash so the HTML tokenizer no longer matches the
 * closing tag (CSS itself happily ignores the backslash since it's not
 * inside a recognised escape sequence; the literal text `<\/style>` is not
 * a valid CSS production but the rule containing it is already inside a
 * `content:` string literal or comment, so the parser drops the rule
 * rather than emitting it). Case-insensitive because the HTML tokenizer is.
 *
 * See https://html.spec.whatwg.org/multipage/parsing.html#parse-error-end-tag-in-style
 */
function escapeStyleTagBoundary(css: string): string {
  // `<style>` itself can't appear meaningfully in CSS, but the same escape
  // rule applies and being symmetric keeps the substitution easier to audit.
  return css.replaceAll(/<\/(style)/gi, "<\\/$1");
}

/**
 * CSS productions that must stay at the very top of a stylesheet —
 * `@charset` must be the very first byte, and `@import`, `@layer` (statement
 * form), and `@namespace` must precede any other style rules. Prepending
 * arbitrary CSS in front of one of these silently invalidates the directive,
 * so we leave the stylesheet alone when we detect one of these preambles and
 * emit the prepend CSS via its standalone fallback path instead.
 *
 * Mirrors the same check in Next.js's inline-css path.
 */
const CSS_PREPEND_UNSAFE_PREAMBLE_RE =
  /^\uFEFF?(?:\s|\/\*[\s\S]*?\*\/)*@(charset|import|layer|namespace)\b/i;
function canPrependCss(css: string): boolean {
  return !CSS_PREPEND_UNSAFE_PREAMBLE_RE.test(css);
}

export type RewriteResult = {
  html: string;
  /**
   * True when the rewrite found at least one inlineable link AND was able to
   * safely prepend the supplied `prependCss` into the emitted `<style>` block.
   * Callers track this across stream chunks to decide whether to emit the
   * fallback `<style>` separately (e.g. when no link was inlined at all).
   */
  consumedPrependCss: boolean;
};

/**
 * Rewrite a chunk of HTML so that every recognised RSC stylesheet link tag
 * becomes an inline `<style>` element using the contents from `map`. When
 * the URL is not present in `map` (e.g. a stale entry, a third-party CSS,
 * or no map was registered) the link tag is left in place — the page still
 * works, just without the inlining optimisation.
 *
 * `nonce` is forwarded to the emitted `<style>` so CSP policies that use
 * `style-src 'nonce-…'` continue to apply — the original `<link>` tags
 * don't carry nonces, but inline `<style>` blocks must (otherwise CSP
 * blocks them and the page renders unstyled).
 *
 * When `prependCss` is non-empty, the *first* link that gets rewritten in
 * this call has the prepend CSS spliced in ahead of its file contents (so
 * `next/font` CSS lives in the same `<style>` element as the page CSS,
 * matching Next.js's behavior). Stylesheets whose preamble is import-order-
 * sensitive (`@charset`/`@import`/`@layer`/`@namespace`) skip the merge and
 * leave `consumedPrependCss=false` so the caller can fall back to emitting
 * the prepend via its standalone `<style data-vinext-fonts>` path.
 */
export function rewriteRscCssLinksToInline(
  html: string,
  map: Record<string, string> | undefined,
  nonce?: string,
  prependCss = "",
): RewriteResult {
  if (!map) return { html, consumedPrependCss: false };
  const nonceAttr = createNonceAttribute(nonce);
  let consumedPrependCss = false;
  const rewritten = html.replace(RSC_CSS_LINK_RE, (match, hrefAttr: string) => {
    const href = decodeRscCssHref(hrefAttr);
    let css: string | undefined;
    for (const key of inlineCssMapKeyCandidates(href)) {
      css = map[key];
      if (css !== undefined) break;
    }
    if (css === undefined) return match;
    const shouldPrepend = !consumedPrependCss && prependCss.length > 0 && canPrependCss(css);
    const body = shouldPrepend ? prependCss + "\n" + css : css;
    if (shouldPrepend) consumedPrependCss = true;
    return (
      `<style data-vinext-inline-css="${escapeHtmlAttr(href)}"${nonceAttr}>` +
      `${escapeStyleTagBoundary(body)}</style>`
    );
  });
  return { html: rewritten, consumedPrependCss };
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
 *
 * `nonce` is the SSR-time script/style nonce — when present, the inlined
 * `<style>` tags carry `nonce="…"` so they pass CSP policies that gate
 * inline styles behind `style-src 'nonce-…'`.
 *
 * `prependCss` / `fallbackHTML` together drive the `next/font` merge path:
 * the first inlined `<style>` block has `prependCss` spliced in ahead of its
 * own contents (so font CSS rides along in the same tag as the page CSS,
 * matching Next.js). When no link ever gets rewritten — e.g. the page has
 * no CSS imports at all — `fallbackHTML` is injected right before `</head>`
 * so the font styles still land in the head. Both default to empty, which
 * disables the merge.
 */
export function createInlineCssTransform(
  nonce?: string,
  options: { prependCss?: string; fallbackHTML?: string } = {},
): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending = "";
  let consumedPrependCss = false;
  // Only meaningful when both prependCss and fallbackHTML are non-empty —
  // otherwise there's nothing to fall back to.
  const fallbackEnabled = !!options.prependCss && !!options.fallbackHTML;
  let fallbackEmitted = false;
  let prependCss = options.prependCss ?? "";
  const fallbackHTML = options.fallbackHTML ?? "";

  /**
   * If we still owe the page a font-CSS fallback and the current emit
   * contains `</head>`, splice it in just before. CSS literals containing
   * the substring `</head>` are extremely rare (the HTML parser stays
   * inside `<style>` content mode regardless), so a plain `indexOf` is
   * safe in practice.
   */
  const maybeInjectFallback = (text: string): string => {
    if (!fallbackEnabled || fallbackEmitted || consumedPrependCss) return text;
    const idx = text.indexOf("</head>");
    if (idx === -1) return text;
    fallbackEmitted = true;
    return text.slice(0, idx) + fallbackHTML + text.slice(idx);
  };

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
      // have rewritten. Same buffering also keeps `</head>` from being
      // split across the fallback-injection check.
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
      const result = rewriteRscCssLinksToInline(emit, map, nonce, prependCss);
      if (result.consumedPrependCss) {
        consumedPrependCss = true;
        // Drop the prepend so a later chunk's rewrite doesn't duplicate it.
        prependCss = "";
      }
      const out = maybeInjectFallback(result.html);
      if (out) controller.enqueue(encoder.encode(out));
    },
    flush(controller) {
      const map = getInlineCssMap();
      let tail = "";
      if (pending) {
        const result = rewriteRscCssLinksToInline(pending, map, nonce, prependCss);
        if (result.consumedPrependCss) {
          consumedPrependCss = true;
          prependCss = "";
        }
        tail = maybeInjectFallback(result.html);
        pending = "";
      }
      // Last-resort fallback: stream ended without our ever seeing
      // `</head>` (malformed HTML, or the page never closed `<head>`).
      // Emit the font CSS at the tail so it's at least present in the
      // document — browsers happily apply `<style>` outside `<head>`.
      if (fallbackEnabled && !fallbackEmitted && !consumedPrependCss) {
        tail += fallbackHTML;
        fallbackEmitted = true;
      }
      if (tail) controller.enqueue(encoder.encode(tail));
    },
  });
}
