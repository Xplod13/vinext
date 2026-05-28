/**
 * vinext styled-jsx plugin
 *
 * Minifies the inline CSS inside `<style jsx>` (and `<style jsx global>`)
 * blocks at transform time, so the SSR HTML matches Next.js's canonical
 * minified output shape.
 *
 * ## Background
 *
 * Next.js's compiler (SWC/Babel) ships a styled-jsx transform that rewrites
 *
 *   <style jsx>{`p { color: blue; }`}</style>
 *
 * into a `JSXStyle` element whose `css` payload is already minified by
 * styled-jsx's stylis fork (e.g. `p{color:blue}`). The SSR head therefore
 * emits `<style>p{color:blue}</style>`, which is what the Next.js
 * `test/e2e/streaming-ssr` regression expects:
 *
 *   expect(html).toMatch(/color:(?:blue|#00f)/)
 *
 * vinext uses Vite's OXC JSX transform, which does not include the styled-jsx
 * compiler step. Without intervention, the JSX child template literal is
 * passed through verbatim and React renders it as raw text content of a
 * `<style>` element — preserving every newline and indent the developer
 * wrote in source. That breaks the `color:blue` (no-space) match.
 *
 * ## Strategy
 *
 * We run a `enforce: "pre"` source transform that finds `<style jsx ...>`
 * blocks containing a single template-literal CSS payload and rewrites the
 * inner literal to its minified form. We also strip the boolean `jsx` /
 * `global` JSX attributes so React does not warn about unknown DOM props.
 *
 * Full styled-jsx semantics (scoped class hashing, dynamic interpolations,
 * `<style jsx global>` vs. component scope) are not implemented — only the
 * minification step required to match the canonical SSR-rendered shape.
 * Pages that rely on selector scoping fall back to writing global rules,
 * which is the same behaviour a developer would get from the issue's
 * fixture (`p { color: blue }` with a single `<p>` on the page).
 *
 * Related: https://github.com/cloudflare/vinext/issues/1556
 */

import type { Plugin } from "vite";

// ── Constants ─────────────────────────────────────────────────────────────────

/** Cheap pre-filter: only run the regex on sources that actually contain `<style jsx`. */
const STYLE_JSX_HINT = "<style jsx";

/**
 * Matches `<style jsx ...>{`...`}</style>` (and `<style jsx global ...>`).
 *
 * Groups:
 *   1. attribute span between `<style` and `>` (preserved so callers can
 *      strip just the `jsx`/`global` flags and keep `nonce`, `id`, …)
 *   2. template literal source (raw CSS, including any `${…}` expressions)
 *
 * Limitations:
 *   - Only handles a single template literal child wrapped in JSX braces.
 *     `<style jsx>{`a`}{`b`}</style>` is rare in real code; the styled-jsx
 *     compiler also only minifies the literal it can see.
 *   - Does not match `<style jsx>{someVar}</style>` — without a literal we
 *     have nothing to minify at build time.
 */
const STYLE_JSX_RE = /<style((?:\s+[^>]*?)?)\s*>\s*\{\s*`([\s\S]*?)`\s*\}\s*<\/style>/g;

/** Attribute regex: matches `jsx` or `global` as standalone boolean attrs. */
const JSX_FLAG_ATTR_RE = /\s+(jsx|global)(?=\s|$|=)(?:=\{?\s*true\s*\}?)?/g;

// ── CSS minifier ──────────────────────────────────────────────────────────────

/**
 * Minify a CSS string the same way styled-jsx's stylis fork does for the
 * common shape produced by `<style jsx>` blocks. We do *not* aim for full
 * stylis parity — only what the streaming-ssr regression cares about:
 *
 *   1. Strip CSS comments (`/* … *\/`).
 *   2. Collapse all whitespace runs (including newlines) to nothing where
 *      the surrounding tokens already disambiguate (around `{ } : ; ,`),
 *      otherwise to a single space.
 *   3. Trim trailing whitespace and the final optional `;` before `}`.
 *
 * The result for `p { color: blue; }` is `p{color:blue}`.
 *
 * Interpolations (`${foo}`) are preserved verbatim — styled-jsx routes them
 * through the dynamic-rule path; here we keep the text untouched so the
 * (rare) page that uses them still renders something readable, even if
 * scoping/minification of the dynamic chunk is lossy.
 */
export function minifyStyledJsxCss(css: string): string {
  // Strip /* … */ comments.
  let out = css.replace(/\/\*[\s\S]*?\*\//g, "");
  // Drop whitespace adjacent to structural punctuation.
  out = out.replace(/\s*([{}:;,])\s*/g, "$1");
  // Collapse remaining runs of whitespace (between value tokens) to one space.
  out = out.replace(/\s+/g, " ");
  // Remove the final `;` before a closing `}` — purely cosmetic, matches
  // stylis output.
  out = out.replace(/;}/g, "}");
  return out.trim();
}

// ── Plugin ────────────────────────────────────────────────────────────────────

/** File extensions we should scan. Mirrors the JSX-capable set vinext uses elsewhere. */
const JSX_EXT_RE = /\.(?:[cm]?jsx?|tsx)$/;

export function styledJsxPlugin(): Plugin {
  return {
    name: "vinext:styled-jsx",
    // Run before `vite:oxc` / `@vitejs/plugin-react` so the JSX transform
    // sees the rewritten (already-minified) template literal.
    enforce: "pre",

    transform(code, id) {
      // Skip non-JSX-capable files and virtual modules.
      if (id.startsWith("\0")) return null;
      const cleanId = id.split("?")[0];
      if (!JSX_EXT_RE.test(cleanId)) return null;
      // Skip files inside node_modules — library code that ships JSX
      // typically pre-compiles styled-jsx at publish time.
      if (cleanId.includes("/node_modules/")) return null;
      // Cheap pre-check so we don't run the regex on every module.
      if (!code.includes(STYLE_JSX_HINT)) return null;

      let mutated = false;
      const rewritten = code.replace(STYLE_JSX_RE, (_match, attrSpan: string, cssBody: string) => {
        // Only act on tags that actually have the `jsx` flag (so we don't
        // touch unrelated `<style>{`…`}</style>` JSX a developer wrote
        // intentionally).
        if (!/\bjsx\b/.test(attrSpan)) {
          return _match;
        }
        const minified = minifyStyledJsxCss(cssBody);
        // Drop the boolean `jsx`/`global` flags so React doesn't warn
        // about unknown attributes on the rendered <style> element.
        const cleanedAttrs = attrSpan.replace(JSX_FLAG_ATTR_RE, "");
        mutated = true;
        return `<style${cleanedAttrs}>{\`${minified}\`}</style>`;
      });

      if (!mutated) return null;
      // No source map: we collapse whitespace inside a template literal but
      // keep the surrounding JSX structure intact, so line numbers outside
      // the literal are preserved. Returning a map would only help debug
      // the minified CSS itself, which is not source the developer wrote.
      return { code: rewritten, map: null };
    },
  };
}
