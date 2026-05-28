/**
 * Client-side cleanup for `experimental.inlineCss`.
 *
 * After a client navigation commits, React's preinit mechanism may add a
 * `<link rel="stylesheet" href="/foo.css">` for a stylesheet whose contents
 * the server already inlined as a `<style data-vinext-inline-css="/foo.css">`
 * block. The duplicate `<link>` re-fetches CSS the browser already has and
 * forces an unnecessary network round-trip on every navigation. Matches the
 * upstream Next.js cleanup: see
 * test/e2e/app-dir/app-inline-css/index.test.ts (the "Navigate from inline
 * page to duplicate global CSS page" expectation).
 *
 * Run this from `BrowserRoot`'s post-commit effect so it fires after React
 * has applied every preinit'd link tag for the new route, but before the
 * user perceives a flash of un-inlined styles.
 */

type InlineCssLinkLike = Pick<HTMLLinkElement, "getAttribute" | "hasAttribute">;

const HTML_TOKEN_SPLIT_RE = /[\t\n\f\r ]+/;

/**
 * `<link rel="…">` accepts a space-separated token list (`rel="preload
 * stylesheet"` is valid). Match each token individually rather than the
 * literal attribute value, mirroring the HTML spec's rel parser.
 */
function relContainsStylesheet(rel: string | null): boolean {
  if (rel === null) return false;
  for (const token of rel.split(HTML_TOKEN_SPLIT_RE)) {
    if (token.length > 0 && token.toLowerCase() === "stylesheet") return true;
  }
  return false;
}

/**
 * Exposed for unit tests. A link is in scope for inline-CSS cleanup when
 * its `rel` token list includes `stylesheet` and it actually has an `href`.
 * We deliberately do *not* require `data-precedence` here — React Fizz emits
 * it consistently but the contract is "stylesheets covered by inline CSS,"
 * not "stylesheets emitted by React."
 */
export function isInlineCssStylesheetLinkElement(link: InlineCssLinkLike): boolean {
  return relContainsStylesheet(link.getAttribute("rel")) && link.hasAttribute("href");
}

/**
 * Resolve two href strings to the same absolute URL when possible, falling
 * back to literal equality. Inline `<style>` blocks store the server-side
 * `data-rsc-css-href` (a path, or a fully-qualified URL when `assetPrefix`
 * is absolute); React's preinit-injected `<link>` resolves through
 * `document.baseURI`. Normalising both through `URL` makes the comparison
 * symmetric across both forms.
 */
function hrefsMatch(a: string, b: string): boolean {
  if (a === b) return true;
  try {
    return new URL(a, window.location.href).href === new URL(b, window.location.href).href;
  } catch {
    return false;
  }
}

export function removeStylesheetLinksCoveredByInlineCss(): void {
  if (typeof document === "undefined") return;
  const inlineStyles = document.head.querySelectorAll<HTMLStyleElement>(
    "style[data-vinext-inline-css]",
  );
  if (inlineStyles.length === 0) return;

  const inlineHrefs: string[] = [];
  for (const style of inlineStyles) {
    const value = style.getAttribute("data-vinext-inline-css");
    if (value) inlineHrefs.push(value);
  }
  if (inlineHrefs.length === 0) return;

  const links = document.head.querySelectorAll<HTMLLinkElement>("link[rel][href]");
  for (const link of links) {
    if (!isInlineCssStylesheetLinkElement(link)) continue;
    const linkHref = link.getAttribute("href");
    if (!linkHref) continue;
    for (const inlineHref of inlineHrefs) {
      if (hrefsMatch(inlineHref, linkHref)) {
        link.remove();
        break;
      }
    }
  }
}
