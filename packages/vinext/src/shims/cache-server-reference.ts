/**
 * Single `registerServerReference` import site for the inline "use cache"
 * transform ("vinext:use-cache", RSC environment only), which prepends an
 * import of this shim — by absolute file:// URL, exactly like the
 * cache-runtime import next to it — into modules containing inline
 * "use cache" functions.
 *
 * Why not import "@vitejs/plugin-rsc/react/rsc" from the transformed module
 * directly? The prepended import must use an absolute file:// specifier: the
 * transformed module can live outside the project root (e.g. linked
 * workspace sources), where the bare specifier may not resolve. But the
 * cache runtime (./cache-runtime.ts) loads the same package via the bare
 * specifier, and pairing a file:// URL of the package entry file with a bare
 * import of the package would rely on Vite normalising both to a single
 * module id — a latent coupling to plugin-rsc's module-id normalisation.
 *
 * Routing the transform's import through this vinext-owned shim removes that
 * coupling by construction: the only react/rsc specifier in play is the bare
 * one below, resolved from the same importer location (vinext's shims
 * directory) as cache-runtime's, so both observe the same module instance no
 * matter how plugin-rsc normalises ids. The shim itself is only ever
 * imported via the transform's file:// URL, so it has a single module id
 * too.
 */
export { registerServerReference } from "@vitejs/plugin-rsc/react/rsc";
