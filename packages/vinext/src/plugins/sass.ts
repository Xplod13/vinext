/**
 * Map a Next.js `sassOptions` object onto Vite's
 * `css.preprocessorOptions.scss` / `.sass` shape.
 *
 * Next.js (webpack + sass-loader) accepts:
 * - `additionalData` (or legacy `prependData`) — prepended to every source
 * - `includePaths` — directories searched by `@import`
 * - `loadPaths`    — modern Sass equivalent of `includePaths`
 * - `implementation` — Sass implementation package name (e.g. `sass-embedded`)
 * - other Sass options that get forwarded as-is
 *
 * Reference (Next.js source — destructures the same keys before forwarding
 * the rest to sass-loader):
 *   .nextjs-ref/packages/next/src/build/webpack/config/blocks/css/index.ts#L150-L180
 *   https://github.com/vercel/next.js/blob/canary/packages/next/src/build/webpack/config/blocks/css/index.ts
 *
 * Vite expects:
 * - `additionalData` (string or function) on the preprocessor options
 * - modern Sass options (`loadPaths`, `importers`, `implementation`, …)
 *   flattened next to `additionalData`
 *
 * @see https://vite.dev/config/shared-options.html#css-preprocessoroptions
 */

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { ResolvedConfig } from "vite";

type AdditionalData = string | ((source: string, filename: string) => string | Promise<string>);

type VitePreprocessorOptions = {
  additionalData?: AdditionalData;
  loadPaths?: string[];
  // oxlint-disable-next-line typescript/no-explicit-any
  [key: string]: any;
};

/**
 * Create a Sass `FileImporter` that resolves webpack-style tilde (`~`) imports.
 *
 * Next.js (via sass-loader's `webpackImporter`) supports two tilde forms:
 *
 * 1. `~pkg/path` — resolves `pkg/path` from `node_modules`. Used for
 *    third-party SCSS/CSS, e.g. `@import '~nprogress/nprogress.css'`.
 *
 * 2. `~/path` — resolves relative to the **project root** (the `~` acts as
 *    an alias for the root). Used with Turbopack's `resolveAlias: { '~*': '*' }`
 *    convention, e.g. `@use '~/styles/variables' as *`.
 *
 * Vite's built-in Sass resolver does not strip the `~` prefix, so any SCSS
 * that uses tilde imports fails with "Can't find stylesheet to import" errors.
 * This `FileImporter` runs before Vite's internal importer (added at the end
 * of `importers[]` in the vite:css plugin) and canonicalises tilde URLs so
 * Sass can load them from the filesystem.
 *
 * The returned object implements the modern Sass `FileImporter` interface:
 * `findFileUrl` returns a `file://` URL and Sass automatically handles partial
 * resolution (`_variables.scss` for `variables`), index files, and extensions.
 *
 * @param root - Absolute path to the Vite project root (used as the base for
 *   `~/path` resolution and for locating `node_modules`).
 */
export function createSassTildeImporter(root: string): { findFileUrl(url: string): URL | null } {
  // Base URL for root-relative (~/) imports. Must end with "/" so new URL()
  // treats it as a directory and resolves relative paths correctly.
  const rootBaseUrl = pathToFileURL(root.endsWith("/") ? root : root + "/");

  // Base URL for node_modules imports. The trailing "/" is critical for
  // new URL(spec, base) to keep the spec as a relative path inside the dir.
  const nodeModulesBaseUrl = pathToFileURL(path.join(root, "node_modules") + "/");

  return {
    findFileUrl(url: string): URL | null {
      if (!url.startsWith("~")) return null;

      const stripped = url.slice(1); // Remove the leading "~"

      if (stripped.startsWith("/")) {
        // Form: ~/path/to/file  →  root-relative
        // stripped = "/path/to/file", we want "<root>/path/to/file"
        // Slice the leading "/" to make it a relative-to-base URL.
        return new URL(stripped.slice(1), rootBaseUrl);
      }

      if (!stripped) {
        // Bare "~" with nothing after it — not a valid import, skip.
        return null;
      }

      // Form: ~pkg/path  →  node_modules resolution
      // Try the simple path first: root/node_modules/pkg/path
      const simpleResolved = new URL(stripped, nodeModulesBaseUrl);

      // Verify the package directory exists in root's node_modules before
      // returning; if not found there, fall back to Node.js module resolution
      // which walks up the directory tree (handles hoisted pnpm graphs, etc.).
      const pkgName = stripped.startsWith("@")
        ? stripped.split("/").slice(0, 2).join("/")
        : (stripped.split("/")[0] ?? "");

      const directPkgDir = path.join(root, "node_modules", pkgName);
      if (pkgName && fs.existsSync(directPkgDir)) {
        // Fast path: package is at root/node_modules/<pkg>
        return simpleResolved;
      }

      // Slow path: use Node.js module resolution to locate the package.
      // This handles pnpm's virtual store layout, yarn PnP, and workspaces
      // where packages aren't necessarily at <root>/node_modules/<pkg>.
      const req = createRequire(path.join(root, "package.json"));
      try {
        const pkgJsonPath = req.resolve(`${pkgName}/package.json`);
        const pkgDir = path.dirname(pkgJsonPath);
        // Build the URL by replacing the package-name segment with the
        // resolved absolute package directory path.
        const afterPkg = stripped.startsWith("@")
          ? stripped.split("/").slice(2).join("/")
          : stripped.split("/").slice(1).join("/");
        const resolvedPath = afterPkg ? path.join(pkgDir, afterPkg) : pkgDir;
        return pathToFileURL(resolvedPath);
      } catch {
        // Package not found via Node.js resolution either — let Sass/Vite's
        // default resolver handle (or report an error for) this import.
        return null;
      }
    },
  };
}

export function buildSassPreprocessorOptions(
  sassOptions: Record<string, unknown> | null | undefined,
): VitePreprocessorOptions | undefined {
  if (!sassOptions || typeof sassOptions !== "object") return undefined;

  const {
    prependData,
    additionalData,
    includePaths,
    loadPaths,
    // oxlint-disable-next-line typescript/no-explicit-any
    ...rest
  } = sassOptions as Record<string, unknown>;

  const out: VitePreprocessorOptions = { ...rest };

  // Next.js forwards `sassPrependData || sassAdditionalData` to sass-loader's
  // `additionalData` (truthy-OR, see
  // .nextjs-ref/packages/next/src/build/webpack/config/blocks/css/index.ts:178),
  // so falsy values like `prependData: ""` fall through to `additionalData`.
  // Mirror that precedence exactly so users migrating from Next.js 12
  // (`prependData`) continue to work.
  const data = prependData || additionalData;
  if (typeof data === "string" || typeof data === "function") {
    out.additionalData = data as AdditionalData;
  }

  // Merge legacy `includePaths` into modern `loadPaths`. Modern Sass dropped
  // `includePaths` in favour of `loadPaths`; Vite uses the modern API, so we
  // alias for users who still configure the legacy name.
  const mergedLoadPaths: string[] = [];
  if (Array.isArray(loadPaths)) {
    for (const p of loadPaths) if (typeof p === "string") mergedLoadPaths.push(p);
  }
  if (Array.isArray(includePaths)) {
    for (const p of includePaths) if (typeof p === "string") mergedLoadPaths.push(p);
  }
  if (mergedLoadPaths.length > 0) {
    out.loadPaths = mergedLoadPaths;
  }

  // If nothing useful was extracted, signal "no override needed" so callers
  // can skip injecting an empty preprocessorOptions object.
  if (Object.keys(out).length === 0) return undefined;

  return out;
}

// ── Sass-aware CSS Modules Loader ─────────────────────────────────────────────
//
// postcss-modules' built-in FileSystemLoader reads files referenced by
// `composes: className from './other.module.scss'` as raw text and runs
// them through PostCSS's CSS-module scoping plugins directly — without Sass
// preprocessing.  For `.scss`/`.sass` files this leaves SCSS variables
// (`$var: red;`) and bare `@import 'file.scss'` directives in the CSS output,
// which then causes LightningCSS to fail during the production minification
// step ("Invalid empty selector").
//
// The fix: provide a custom `Loader` class via `css.modules.Loader` in the
// Vite config.  The custom Loader uses Vite's `preprocessCSS` for every
// file referenced by `composes:` so that Sass preprocessing (for `.scss`/
// `.sass`) runs before the CSS-module scoping step.  `preprocessCSS` is
// marked @experimental in Vite but has been stable in practice across Vite
// 5/6/7.
//
// Relates to: https://github.com/cloudflare/vinext/issues/1825
//
// Reference: https://vite.dev/guide/api-javascript#preprocesscss

/** Module-level resolved config set by `setSassLoaderResolvedConfig`. */
let _resolvedConfig: ResolvedConfig | null = null;

/**
 * Called from vinext's `configResolved` hook so the custom Loader can use
 * Vite's resolved config when preprocessing CSS module dependencies.
 */
export function setSassLoaderResolvedConfig(config: ResolvedConfig): void {
  _resolvedConfig = config;
}

/**
 * Sort key comparator used by postcss-modules' FileSystemLoader to determine
 * the order in which dependency CSS is prepended to the output.
 * Mirrors the original `traceKeySorter` from postcss-modules source.
 */
function traceKeySorter(a: string, b: string): number {
  if (a.length < b.length) return a < b.substring(0, a.length) ? -1 : 1;
  if (a.length > b.length) return a.substring(0, b.length) <= b ? -1 : 1;
  return a < b ? -1 : 1;
}

type PreprocessCSS = (code: string, filename: string, config: ResolvedConfig) => Promise<unknown>;

/** Lazily resolved reference to Vite's `preprocessCSS` export. */
let _preprocessCSS: PreprocessCSS | null | undefined; // undefined = not yet loaded

async function getPreprocessCSS(): Promise<PreprocessCSS | null> {
  if (_preprocessCSS !== undefined) return _preprocessCSS;
  try {
    const vite = await import("vite");
    const viteExports = vite as Record<string, unknown>;
    _preprocessCSS =
      typeof viteExports["preprocessCSS"] === "function"
        ? (viteExports["preprocessCSS"] as PreprocessCSS)
        : null;
  } catch {
    _preprocessCSS = null;
  }
  return _preprocessCSS;
}

/**
 * Sass-aware replacement for postcss-modules' `FileSystemLoader`.
 *
 * Implements the same constructor + `fetch` + `finalSource` interface that
 * postcss-modules calls when resolving `composes: className from 'file'`
 * dependencies.
 *
 * For every dependency file, Vite's `preprocessCSS` is used so that:
 * - `.scss`/`.sass` files are compiled through Sass *before* CSS-module
 *   scoping runs (fixing the "Invalid empty selector" LightningCSS crash).
 * - `.module.css` and `.module.scss` files have their class names scoped and
 *   export tokens extracted in exactly the same way as the top-level file.
 *
 * When `preprocessCSS` is unavailable or the resolved config has not been set
 * yet, the Loader silently falls back to returning an empty token map so the
 * build continues without crashing (class composition may be incomplete but
 * the build succeeds).
 */
export class SassAwareFileSystemLoader {
  readonly root: string;
  private readonly fileResolve:
    | ((newPath: string, relativeTo: string) => Promise<string>)
    | undefined;
  private readonly sources: Record<string, string>;
  private readonly traces: Record<string, string>;
  private importNr: number;
  private readonly tokensByFile: Record<string, Record<string, string>>;

  constructor(
    root: string,
    // The `plugins` parameter is the postcss-modules plugin list; passed by
    // postcss-modules but not needed here since we delegate to `preprocessCSS`.
    _plugins: unknown[],
    fileResolve?: (newPath: string, relativeTo: string) => Promise<string>,
  ) {
    if (root === "/" && process.platform === "win32") {
      const cwdDrive = process.cwd().slice(0, 3);
      if (!/^[A-Za-z]:\\$/.test(cwdDrive))
        throw new Error(`Failed to obtain root from "${process.cwd()}".`);
      root = cwdDrive;
    }
    this.root = root;
    this.fileResolve = fileResolve;
    this.sources = {};
    this.traces = {};
    this.importNr = 0;
    this.tokensByFile = {};
  }

  async fetch(
    _newPath: string,
    relativeTo: string,
    _trace?: string,
  ): Promise<Record<string, string>> {
    const newPath = _newPath.replace(/^["']|["']$/g, "");
    const trace = _trace ?? String.fromCharCode(this.importNr++);

    const useFileResolve = typeof this.fileResolve === "function";
    const fileResolvedPath = useFileResolve
      ? await this.fileResolve(newPath, relativeTo)
      : undefined;

    if (fileResolvedPath !== undefined && !path.isAbsolute(fileResolvedPath)) {
      throw new Error('The returned path from the "fileResolve" option must be absolute.');
    }

    const relativeDir = path.dirname(relativeTo);
    const fileRelativePath =
      fileResolvedPath ??
      (() => {
        let resolved = path.resolve(path.resolve(this.root, relativeDir), newPath);
        // Handle bare package imports (e.g. `composes: foo from 'pkg/styles.css'`).
        if (!useFileResolve && newPath[0] !== "." && !path.isAbsolute(newPath)) {
          try {
            // Resolve bare specifiers via Node's module algorithm,
            // rooted at this module's URL so the lookup traverses
            // the project's node_modules tree.
            resolved = createRequire(import.meta.url).resolve(newPath);
          } catch {
            // ignore — bare specifier may not be a Node package
          }
        }
        return resolved;
      })();

    const cached = this.tokensByFile[fileRelativePath];
    if (cached) return cached;

    const config = _resolvedConfig;
    const preprocessCSS = await getPreprocessCSS();

    if (preprocessCSS && config) {
      try {
        const rawSource = await fs.promises.readFile(fileRelativePath, "utf-8");
        // `preprocessCSS` handles Sass compilation (for .scss/.sass) AND
        // postcss-modules scoping (for .module.* files) in one shot, using
        // the same resolved config as the main Vite build so hashes and
        // scoped-name generation are consistent.
        const resultRaw = await preprocessCSS(rawSource, fileRelativePath, config);
        const result = resultRaw as Record<string, unknown>;
        const injectableSource: string = typeof result["code"] === "string" ? result["code"] : "";
        const rawModules = result["modules"];
        const exportTokens: Record<string, string> =
          rawModules != null && typeof rawModules === "object"
            ? (rawModules as Record<string, string>)
            : {};

        this.sources[fileRelativePath] = injectableSource;
        this.traces[trace] = fileRelativePath;
        this.tokensByFile[fileRelativePath] = exportTokens;
        return exportTokens;
      } catch {
        // Preprocessing failed (e.g. Sass not installed, file unreadable).
        // Return an empty token map so the build continues.
      }
    }

    // Fallback when preprocessCSS is unavailable or config not yet resolved.
    // Read the raw file and return empty tokens; class composition will be
    // incomplete but the build will not crash.
    return new Promise<Record<string, string>>((resolve, reject) => {
      fs.readFile(fileRelativePath, "utf-8", (err) => {
        if (err) {
          reject(err);
          return;
        }
        this.sources[fileRelativePath] = "";
        this.traces[trace] = fileRelativePath;
        this.tokensByFile[fileRelativePath] = {};
        resolve({});
      });
    });
  }

  get finalSource(): string {
    const { traces, sources } = this;
    const written = new Set<string>();
    return Object.keys(traces)
      .sort(traceKeySorter)
      .map((key) => {
        const filename = traces[key];
        if (!filename || written.has(filename)) return null;
        written.add(filename);
        return sources[filename];
      })
      .join("");
  }
}
