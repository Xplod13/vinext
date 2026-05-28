import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type { Plugin } from "vite";

/**
 * Decide whether an external request from `importer` would resolve to a
 * different installed copy than the same request from the project root.
 *
 * Returns the absolute resolved path (i.e. the importer's nested copy)
 * when the resolutions differ, or `null` when they're identical (or when
 * resolution fails — in that case we leave the request external and let
 * Vite/Node handle it normally).
 *
 * This mirrors Next.js's webpack handler, which refuses to externalize a
 * request when the resolution from the importer context differs from the
 * project-root resolution (`baseResolveCheck`). Once the request is
 * resolved to an absolute path, Vite no longer matches it against
 * `resolve.external` (which is a list of bare specifiers), so the module
 * gets bundled with the importer instead of being left as a runtime
 * `import "lodash"` that would resolve to the wrong version.
 *
 * See:
 * https://github.com/vercel/next.js/blob/canary/packages/next/src/build/handle-externals.ts
 */
export function resolveTransitiveExternal(
  request: string,
  importer: string,
  rootResolver: NodeRequire,
): string | null {
  let importerResolved: string;
  try {
    const importerRequire = createRequire(importer);
    importerResolved = importerRequire.resolve(request);
  } catch {
    return null;
  }

  let rootResolved: string;
  try {
    rootResolved = rootResolver.resolve(request);
  } catch {
    // Request can't be resolved from the root at all — that's a stronger
    // signal that the importer's nested copy is the only valid one.
    // Returning the importer-resolved path forces Vite to bundle it.
    try {
      return fs.realpathSync(importerResolved);
    } catch {
      return importerResolved;
    }
  }

  let importerReal: string;
  let rootReal: string;
  try {
    importerReal = fs.realpathSync(importerResolved);
  } catch {
    importerReal = importerResolved;
  }
  try {
    rootReal = fs.realpathSync(rootResolved);
  } catch {
    rootReal = rootResolved;
  }

  if (importerReal === rootReal) {
    return null;
  }
  return importerReal;
}

/**
 * vinext:transitive-externals
 *
 * Force Vite to bundle (rather than externalize) imports of packages listed
 * in `serverExternalPackages` when the importer resolves them to a different
 * installed copy than the project root. Without this, two nested copies of
 * a transitive dependency collapse to a single version at runtime — the
 * importer ends up loading whichever copy happens to sit at the top-level
 * `node_modules/<dep>/`, regardless of the version it actually expects.
 *
 * Example layout:
 *
 *   node_modules/lodash/                  # v3.10.1 (root)
 *   node_modules/dep-a/                   # depends on lodash@3
 *   node_modules/dep-b/                   # depends on lodash@4
 *   node_modules/dep-b/node_modules/lodash/  # v4.17.21 (nested)
 *
 * With `serverExternalPackages: ['lodash']`, Vite would normally leave
 * every `import 'lodash'` as a bare runtime require. Both dep-a and dep-b
 * would then resolve `lodash` from the same `dist/server/node_modules/`
 * directory at runtime — only one version can win. This plugin detects
 * dep-b's case, returns the absolute path to its nested lodash copy, and
 * lets Vite bundle that copy alongside dep-b's code.
 *
 * Ports the `baseResolveCheck` behaviour from Next.js's webpack handler:
 * https://github.com/vercel/next.js/blob/canary/packages/next/src/build/handle-externals.ts
 */
export function createTransitiveExternalsPlugin(options: {
  /**
   * Lazy getters so the plugin can read the project root and the
   * resolved next.config values that are populated during
   * `configResolved` — after the plugin factory has already run.
   */
  getRoot: () => string | null;
  getExternalPackages: () => string[];
}): Plugin {
  let externalSet: Set<string> | null = null;
  let rootResolver: NodeRequire | null = null;

  return {
    name: "vinext:transitive-externals",
    enforce: "pre",

    configResolved() {
      const root = options.getRoot();
      if (!root) return;
      externalSet = new Set(options.getExternalPackages());
      rootResolver = createRequire(path.join(root, "package.json"));
    },

    resolveId(source, importer) {
      const set = externalSet;
      const resolver = rootResolver;
      if (!set || !resolver) return null;
      if (!importer || set.size === 0) return null;
      // Only act on bare specifiers that match an externalised package.
      // Match either an exact package name or a subpath import (e.g.
      // "lodash/package.json"). Handle scoped packages too.
      let pkgName: string | null = null;
      if (source.startsWith("@")) {
        const parts = source.split("/");
        if (parts.length >= 2) pkgName = `${parts[0]}/${parts[1]}`;
      } else {
        pkgName = source.split("/")[0] ?? null;
      }
      if (!pkgName || !set.has(pkgName)) return null;

      // Skip importers that aren't real on-disk files (virtual modules,
      // \0-prefixed ids, etc.) — we can't anchor a Node resolver on them.
      if (importer.startsWith("\0") || importer.includes("?")) return null;
      if (!path.isAbsolute(importer)) return null;

      // Skip importers that don't live inside a node_modules tree —
      // imports from the user's own source code are always resolved against
      // the project root anyway, so there's nothing to disambiguate.
      if (!importer.includes(`${path.sep}node_modules${path.sep}`)) return null;

      const resolved = resolveTransitiveExternal(source, importer, resolver);
      if (!resolved) return null;
      return resolved;
    },
  };
}

/** Test helper: build a plugin from a pre-resolved root and package list. */
export function _createPluginForTest(options: {
  root: string;
  externalPackages: string[];
}): Plugin {
  return createTransitiveExternalsPlugin({
    getRoot: () => options.root,
    getExternalPackages: () => options.externalPackages,
  });
}
