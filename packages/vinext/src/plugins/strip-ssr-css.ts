import type { Plugin } from "vite";
import MagicString from "magic-string";

/**
 * Strip CSS references from modules in the SSR / server environment.
 *
 * Vite's `vite:asset-import-meta-url` plugin only runs when
 * `environment.config.consumer === "client"` (see
 * `packages/vite/src/node/plugins/assetImportMetaUrl.ts` upstream). In a
 * server consumer the source-level `new URL("./style.css", import.meta.url)`
 * therefore survives the bundler verbatim. Rolldown then resolves the URL
 * against the SSR chunk's location at runtime — but the referenced CSS asset
 * was never emitted into the SSR output directory, so Node's ESM loader
 * crashes the first time the entry module evaluates:
 *
 *   Error [ERR_MODULE_NOT_FOUND]: Cannot find module
 *     '/.../dist/server/ssr/style.css'
 *     imported from '/.../dist/server/ssr/index.js'
 *
 * The same surface exists for static `import "./style.css"` statements that
 * Rolldown preserves into the SSR chunk when the CSS code-split plugin
 * tree-shakes the asset side-effect (the import survives, the asset does
 * not).
 *
 * CSS is a strictly client-side concern — there is no SSR path that consumes
 * it. The cleanest fix is to neutralize both forms in the SSR environment:
 *
 *  - `import "./x.css"`             →  removed
 *  - `new URL("./x.css", import.meta.url)` →  `new URL("data:,",
 *                                              import.meta.url)`
 *
 * Replacing the URL specifier with `data:,` (an empty data URL) keeps the
 * expression syntactically identical (still a `URL` instance) for any code
 * that incidentally inspects the result, but is a no-op the runtime can
 * always resolve without a file on disk.
 *
 * Mirrors the behavior implicit in Next.js's webpack pipeline, where CSS
 * imports in SSR/edge bundles are stripped to a side-effect-free shim.
 *
 * Relates to deploy-suite failure surfaced by
 * `test/e2e/react-version/pages/api/pages-api-edge-url-dep.js`, which
 * exercises this exact pattern.
 */

// Matches `new URL("./x.css", import.meta.url)` with optional whitespace and
// trailing comma. Captures the full call (group 0), the quoted specifier
// including its surrounding quotes (group 1), and the bare specifier text
// without quotes or any trailing `?query` (group 2). An optional `?…`
// query suffix is allowed on the specifier so callers like
// `new URL("./style.css?foo", import.meta.url)` are matched symmetrically
// with the side-effect import regex below.
const NEW_URL_CSS_RE =
  /\bnew\s+URL\s*\(\s*(["'`]([^"'`]+\.css)(?:\?[^"'`]*)?["'`])\s*,\s*import\.meta\.url\s*(?:,\s*)?\)/g;

// Matches side-effect CSS imports, including a trailing `?…` query so that
// the handler can decide whether the specifier carries a `?url`/`?raw`/
// `?inline`/`?no-inline` contract before stripping:
//   import "./x.css";
//   import "./x.css?url";
// Does NOT match `import x from "./x.css"` — bound imports are intentionally
// rare in user code and removing the binding would break the module
// syntactically.
const SIDE_EFFECT_CSS_IMPORT_RE = /^\s*import\s+(["'])([^"']+\.css(?:\?[^"']*)?)\1\s*;?\s*$/gm;

const ALLOWED_QUERY_RE = /\?(?:url|raw|inline|no-inline)\b/;

/**
 * Cheap pre-filter to avoid AST work on the majority of modules that have
 * nothing to strip. False positives are harmless; the real regexes still
 * gate any rewrites.
 */
function mightHaveCssReference(code: string): boolean {
  return code.includes(".css");
}

/**
 * Apply CSS-stripping rewrites to a single module. Returns the MagicString
 * instance when at least one rewrite ran, or `null` if the module is a
 * no-op. The caller decides whether to call `.toString()` / `.generateMap()`
 * — this keeps the unit-test helper cheap (no source-map work) while
 * letting the Vite plugin emit hires maps.
 */
function applyStripSsrCss(id: string, code: string): MagicString | null {
  if (!mightHaveCssReference(code)) return null;
  // Honor explicit `?url`/`?raw`/`?inline`/`?no-inline` queries on the
  // module ID itself — those modules are intentionally string-typed and
  // we must not touch them.
  if (ALLOWED_QUERY_RE.test(id)) return null;

  let s: MagicString | null = null;

  NEW_URL_CSS_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = NEW_URL_CSS_RE.exec(code))) {
    // Skip new URL("./x.css?url", ...) for the same reason we skip the
    // side-effect form: the user explicitly asked for a string value, so
    // rewriting to `data:,` would lose information they intend to consume.
    const fullQuoted = m[1]!;
    if (ALLOWED_QUERY_RE.test(fullQuoted)) continue;
    const specStart = m.index + m[0].indexOf(fullQuoted);
    const specEnd = specStart + fullQuoted.length;
    if (!s) s = new MagicString(code);
    s.overwrite(specStart, specEnd, '"data:,"');
  }

  SIDE_EFFECT_CSS_IMPORT_RE.lastIndex = 0;
  while ((m = SIDE_EFFECT_CSS_IMPORT_RE.exec(code))) {
    const spec = m[2]!;
    // Skip explicit url/raw/inline queries — those imports return a
    // string and the module body may rely on the binding's value.
    if (ALLOWED_QUERY_RE.test(spec)) continue;
    if (!s) s = new MagicString(code);
    s.overwrite(m.index, m.index + m[0].length, "");
  }

  return s;
}

/**
 * Pure transform that powers the plugin's `transform` hook. Exposed for
 * direct unit testing — call this with `{ id, code }` and assert against
 * the rewritten code without spinning up a Vite build.
 *
 * Returns `null` when no rewrites apply, mirroring the Vite contract.
 */
export function transformSsrCssReferences(id: string, code: string): { code: string } | null {
  const s = applyStripSsrCss(id, code);
  if (!s) return null;
  return { code: s.toString() };
}

export function createStripSsrCssPlugin(): Plugin {
  return {
    name: "vinext:strip-ssr-css",
    applyToEnvironment(environment) {
      // Run for any server-consumer environment (Vite sets this automatically
      // for `ssr` and for the RSC plugin's `rsc` env). The RSC environment
      // already routes CSS through `@vitejs/plugin-rsc`'s code-split path
      // which emits real files, but the static-import branch of this plugin
      // is a no-op there because the CSS imports have already been rewritten
      // to hashed names by the time we see them. We still want the `new URL`
      // branch to apply, since the asset-import-meta-url plugin upstream
      // does not run for server consumers.
      return environment.config.consumer === "server";
    },
    transform: {
      filter: {
        // CSS files themselves still need to pass through Vite's CSS
        // pipeline. Only transform JS/TS modules.
        id: { exclude: /\.css(?:$|\?)/ },
      },
      handler(code, id) {
        const s = applyStripSsrCss(id, code);
        if (!s) return null;
        return {
          code: s.toString(),
          map: s.generateMap({ hires: true }),
        };
      },
    },
  };
}
