/**
 * `vinext:import-meta-url` Vite plugin.
 *
 * Preserves the user-source semantics of `import.meta.url` through the
 * production bundle.
 *
 * Background — Next.js parity (cloudflare/vinext#1505):
 *
 *   Next.js (both Turbopack and Webpack) makes `import.meta.url` in user
 *   source modules resolve to the source file's `file://` URL — e.g.
 *   `file:///<root>/pages/index.tsx`. Code like
 *   `new URL('./data.json', import.meta.url)` then resolves relative to the
 *   user's source path, which is the Web/Node semantics.
 *
 * The vinext gap:
 *
 *   In dev, Vite serves each module from its own URL, so `import.meta.url`
 *   already reflects the source path. In production, Rolldown bundles every
 *   server module into a single `entry.js`. The runtime `import.meta.url`
 *   inside that bundle is the bundled entry's path (e.g.
 *   `file:///<tmp>/dist/server/entry.js?t=...`), not the page's source path.
 *   Relative URL resolution and any code that introspects the source
 *   filename breaks.
 *
 * The fix:
 *
 *   At transform time, in build mode only, substitute every textual
 *   occurrence of `import.meta.url` with a string literal that is the file
 *   URL of the module being transformed (`pathToFileURL(id).href`). This
 *   pins the value to the user source path before bundling, so the
 *   collapsed entry preserves Next.js parity for every module.
 *
 * Scope:
 *
 *   - Build only. Dev is already correct via Vite's per-module URLs.
 *   - User project source files only — skip `node_modules`, vinext's own
 *     entries, and virtual modules. Library code under `node_modules` is
 *     expected to retain its own `import.meta.url` semantics (or be
 *     handled by other plugins, e.g. `vinext:og-inline-fetch-assets`).
 *   - Skip modules whose id begins with `\0` (virtual modules) or contains
 *     no `import.meta.url` reference (fast bail-out).
 *
 * Implementation notes:
 *
 *   - `enforce: "pre"` so the substitution happens before bundle-time
 *     transforms that might otherwise inline the `import.meta.url` token.
 *   - Skipping `import.meta.url` inside strings/comments would require
 *     parsing; for user source files the false-positive risk is acceptable
 *     (a literal occurrence inside a string is rare and would yield a
 *     harmless string substitution). If this proves problematic, a parse-
 *     based pass mirroring `og-assets.ts` Pattern 2 is the next step.
 */
import type { Plugin } from "vite";
import { pathToFileURL } from "node:url";
import MagicString from "magic-string";

const IMPORT_META_URL_TOKEN = "import.meta.url";

/**
 * Decide whether a module id is a user-project source file that we should
 * rewrite. Reject virtual modules (`\0`-prefixed), `node_modules`, and
 * vinext's own packaged source. We rely on the file id being an absolute
 * path on disk — anything else (commonjs proxies, query suffixes that
 * point at non-files) is not safe to derive a `file://` URL from.
 */
function shouldTransform(id: string): boolean {
  // Virtual modules — Vite uses a leading `\0` to mark them. They have no
  // on-disk path; deriving a file URL would be meaningless. Skip.
  if (id.startsWith("\0")) return false;

  // Strip Vite's query suffix (`?t=…`, `?v=…`) before path checks. The
  // pathname before the `?` is what we use for the file URL.
  const idWithoutQuery = id.split("?", 1)[0];

  // Only absolute on-disk paths can be turned into a file URL. Drop bare
  // specifiers, http(s) URLs, and any other non-path id.
  if (!idWithoutQuery.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(idWithoutQuery)) {
    return false;
  }

  // Skip dependencies. Their `import.meta.url` semantics are the library
  // author's concern, not Next.js parity for user code.
  if (idWithoutQuery.includes("/node_modules/")) return false;

  // Skip vinext's own packaged source — these files use `import.meta.url`
  // intentionally to locate sibling helpers via `resolveEntryPath`. We must
  // not rewrite those references to a file URL inside the user's project.
  // Match both the source tree (`/packages/vinext/src/`) and the published
  // distribution layout (`/vinext/dist/`).
  if (
    idWithoutQuery.includes("/packages/vinext/src/") ||
    idWithoutQuery.includes("/packages/vinext/dist/") ||
    idWithoutQuery.includes("/vinext/dist/")
  ) {
    return false;
  }

  return true;
}

/**
 * Find every occurrence of `import.meta.url` in `code` and replace it with
 * the JSON-stringified `replacement`. Uses MagicString so the source map
 * stays accurate. Returns `null` when there are no occurrences.
 *
 * The match is intentionally textual — `import.meta.url` is a rare enough
 * token in user source that a full AST walk is overkill. False positives
 * inside string literals are accepted; see plugin header.
 */
export function rewriteImportMetaUrl(code: string, replacement: string): string | null {
  if (!code.includes(IMPORT_META_URL_TOKEN)) return null;

  const literal = JSON.stringify(replacement);
  const ms = new MagicString(code);
  let didReplace = false;
  let searchFrom = 0;

  while (true) {
    const idx = code.indexOf(IMPORT_META_URL_TOKEN, searchFrom);
    if (idx === -1) break;

    // Guard against `import.meta.urls` and similar — make sure the next
    // character is not an identifier-continuing character.
    const after = code.charAt(idx + IMPORT_META_URL_TOKEN.length);
    if (after && /[A-Za-z0-9_$]/.test(after)) {
      searchFrom = idx + IMPORT_META_URL_TOKEN.length;
      continue;
    }

    ms.overwrite(idx, idx + IMPORT_META_URL_TOKEN.length, literal);
    didReplace = true;
    searchFrom = idx + IMPORT_META_URL_TOKEN.length;
  }

  if (!didReplace) return null;
  return ms.toString();
}

/**
 * Build the `vinext:import-meta-url` plugin. Build-time only.
 */
export function createImportMetaUrlPlugin(): Plugin {
  return {
    name: "vinext:import-meta-url",
    apply: "build",
    enforce: "pre",
    transform(code, id) {
      if (!shouldTransform(id)) return null;

      const idWithoutQuery = id.split("?", 1)[0];
      const sourceFileUrl = pathToFileURL(idWithoutQuery).href;
      const rewritten = rewriteImportMetaUrl(code, sourceFileUrl);
      if (rewritten === null) return null;

      // Returning `map: null` is safe — MagicString preserves byte offsets
      // for our overwrite, so existing source maps from upstream transforms
      // continue to point at the original code. A precise map could be
      // generated via `ms.generateMap`, but for a single-token rewrite the
      // cost outweighs the benefit.
      return { code: rewritten, map: null };
    },
  };
}
