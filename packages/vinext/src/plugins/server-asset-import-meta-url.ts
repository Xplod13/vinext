/**
 * vinext:server-asset-import-meta-url
 *
 * Vite's built-in `vite:asset-import-meta-url` plugin only runs in the
 * `client` environment (it gates on `environment.config.consumer === "client"`).
 * That means `new URL('./style.css', import.meta.url)` references in
 * server-side code (Pages Router API routes, edge runtime handlers,
 * server components) are left untransformed in the SSR bundle, with two
 * consequences:
 *
 *   1. The referenced asset file is never emitted alongside the SSR
 *      bundle, so the resolved URL points at a path that does not exist
 *      on disk.
 *   2. At runtime, `import.meta.url` resolves relative to the emitted
 *      SSR JS, so `new URL('./style.css', import.meta.url)` yields a
 *      `file://` URL under `dist/server/style.css` — and `import(...)`
 *      of that URL crashes with `ERR_MODULE_NOT_FOUND`.
 *
 * This reproduces the Next.js deploy-suite failure described in
 * cloudflare/vinext#1346, mirroring the
 * `test/e2e/react-version/pages/api/pages-api-edge-url-dep.js` fixture
 * which does `import(new URL('./style.css', import.meta.url).href)` from
 * an edge API route purely to validate that URL dependencies don't break
 * the build.
 *
 * Approach:
 *   - In `transform` (non-client environments only) we emit each
 *     referenced asset via `this.emitFile`, then rewrite the original
 *     `new URL("./X", import.meta.url)` to use a vinext-internal
 *     placeholder containing the reference id.
 *   - In `renderChunk` we resolve the placeholder to a relative URL from
 *     the host chunk to the emitted asset (e.g. `./_next/static/<hash>.css`).
 *     A relative URL is required because in SSR/server builds Vite's
 *     default `toOutputFilePathInJS` returns the root-absolute URL
 *     (`/_next/static/...`), which `new URL(..., import.meta.url)` would
 *     resolve to `file:///_next/static/...` at Node runtime — outside
 *     the build output directory.
 *
 * Skipped when the user adds a `/* @vite-ignore *\/` comment, matching
 * Vite's upstream behaviour.
 */

import type { Plugin } from "vite";
import path from "node:path";
import fs from "node:fs";

// Matches `new URL("./foo.css", import.meta.url)` — quoted string literals
// (no template literals) and relative specifiers only. Template literals
// with `${...}` interpolation are not handled here; Vite's upstream plugin
// uses `import.meta.glob` for those, which is a client-only concern.
const ASSET_IMPORT_META_URL_RE =
  /\bnew\s+URL\s*\(\s*(['"])(\.\.?\/[^'"`]+)\1\s*,\s*import\.meta\.url\s*(?:,\s*)?\)/g;
const VITE_IGNORE_RE = /\/\*\s*@vite-ignore\s*\*\//;

// Placeholder that survives Vite's renderChunk pipeline (it does not start
// with `__VITE_ASSET__`, so Vite's own asset resolver leaves it alone) and
// is resolved by this plugin's own renderChunk hook.
const PLACEHOLDER_PREFIX = "__VINEXT_SERVER_ASSET__";
const PLACEHOLDER_SUFFIX = "__";
const PLACEHOLDER_RE = new RegExp(`${PLACEHOLDER_PREFIX}([\\w$-]+)${PLACEHOLDER_SUFFIX}`, "g");

/**
 * Create the `vinext:server-asset-import-meta-url` Vite plugin.
 *
 * Emits assets referenced via `new URL("./path", import.meta.url)` in
 * server environments and rewrites the URL to point at the emitted file
 * so the runtime can resolve it.
 */
export function createServerAssetImportMetaUrlPlugin(): Plugin {
  return {
    name: "vinext:server-asset-import-meta-url",
    enforce: "pre",
    apply: "build",
    // Run for all non-client environments (Pages Router SSR build, App
    // Router ssr environment, RSC environment, Cloudflare worker
    // environment). Vite's upstream plugin already covers `client`.
    applyToEnvironment(environment) {
      return environment.config.consumer !== "client";
    },
    transform: {
      filter: { code: ASSET_IMPORT_META_URL_RE },
      async handler(code, id) {
        // Skip virtual modules — `id` would not be a real file system path
        // and resolving the relative URL against it would be meaningless.
        if (id.startsWith("\0") || id.startsWith("virtual:")) return null;

        const moduleDir = path.dirname(id.split("?")[0]!);
        let result = "";
        let lastIndex = 0;
        let didReplace = false;
        const re = new RegExp(ASSET_IMPORT_META_URL_RE);
        let match: RegExpExecArray | null;

        while ((match = re.exec(code))) {
          const fullMatch = match[0];
          const matchStart = match.index;
          const matchEnd = matchStart + fullMatch.length;
          const url = match[2]!;

          // Honour `/* @vite-ignore */` to match Vite's upstream contract.
          // The comment appears between `new URL(` and the string literal
          // in the original source, so scan that slice.
          const literalStart = code.indexOf(match[1]!, matchStart);
          if (literalStart !== -1 && VITE_IGNORE_RE.test(code.slice(matchStart, literalStart))) {
            continue;
          }

          const file = path.resolve(moduleDir, url);
          let buffer: Buffer;
          try {
            buffer = await fs.promises.readFile(file);
          } catch {
            // File does not exist on disk — likely a runtime-generated
            // path or the developer expects the asset to be present
            // elsewhere. Leave the expression alone.
            continue;
          }

          const referenceId = this.emitFile({
            type: "asset",
            name: path.basename(file),
            source: buffer,
          });

          if (matchStart > lastIndex) {
            result += code.slice(lastIndex, matchStart);
          }
          // Replace the entire `new URL("./X", import.meta.url)` expression
          // with a plugin-private placeholder wrapped in `new URL(...,
          // import.meta.url)`. The placeholder is resolved in renderChunk
          // (below) to a chunk-relative URL so the runtime computes the
          // correct file:// URL at module load time.
          result += `new URL(${JSON.stringify(
            `${PLACEHOLDER_PREFIX}${referenceId}${PLACEHOLDER_SUFFIX}`,
          )}, import.meta.url)`;
          lastIndex = matchEnd;
          didReplace = true;
        }

        if (!didReplace) return null;
        if (lastIndex < code.length) {
          result += code.slice(lastIndex);
        }
        return { code: result, map: null };
      },
    },
    renderChunk(code, chunk) {
      if (!code.includes(PLACEHOLDER_PREFIX)) return null;
      const re = new RegExp(PLACEHOLDER_RE);
      let match: RegExpExecArray | null;
      let result = "";
      let lastIndex = 0;
      let didReplace = false;

      // Compute a POSIX-style chunk-relative URL to each emitted asset so
      // `new URL(<placeholder>, import.meta.url)` resolves to the real
      // file at Node runtime. Vite's default for SSR returns a root-
      // absolute path (`/_next/static/...`), which would resolve to
      // `file:///_next/...` and crash.
      const chunkDir = path.posix.dirname(chunk.fileName);
      const toRelative = (assetFileName: string) => {
        let rel = path.posix.relative(chunkDir, assetFileName);
        if (!rel.startsWith(".")) rel = `./${rel}`;
        return rel;
      };

      while ((match = re.exec(code))) {
        const fullMatch = match[0];
        const referenceId = match[1]!;
        let assetFileName: string;
        try {
          assetFileName = this.getFileName(referenceId);
        } catch {
          continue;
        }
        const replacement = toRelative(assetFileName);
        if (match.index > lastIndex) {
          result += code.slice(lastIndex, match.index);
        }
        // Re-encode as a JS string literal — we are substituting inside
        // a `JSON.stringify`-emitted literal in the original source.
        result += JSON.stringify(replacement).slice(1, -1);
        lastIndex = match.index + fullMatch.length;
        didReplace = true;
      }

      if (!didReplace) return null;
      if (lastIndex < code.length) {
        result += code.slice(lastIndex);
      }
      return { code: result, map: null };
    },
  } satisfies Plugin;
}
