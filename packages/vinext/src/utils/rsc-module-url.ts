import path from "node:path";

/**
 * Resolve the dev-server URL Vite uses for an App Router source file in the rsc
 * environment.
 *
 * Prefers the live module URL from the HMR context (`ctx.modules`), since that
 * is exactly what Vite registered. Falls back to the conventional source URL
 * when the module has dropped out of the graph — e.g. after a transform error,
 * which is precisely the case the dev-overlay recovery hook needs to handle, so
 * it can re-transform the file and detect that it now compiles.
 *
 * Files under the project root resolve to a root-relative URL (`/app/page.tsx`);
 * files outside the root use Vite's absolute-filesystem form (`/@fs/...`).
 */
export function resolveRscModuleUrl(
  file: string,
  modules: ReadonlyArray<{ url?: string | null }>,
  root: string,
): string {
  for (const mod of modules) {
    if (mod && typeof mod.url === "string" && mod.url.length > 0) return mod.url;
  }
  // Normalize Windows separators on any platform so URL construction is stable
  // regardless of the OS the dev server runs on.
  const normalizedFile = file.replaceAll("\\", "/");
  const normalizedRoot = root.replaceAll("\\", "/");
  const relative = path.posix.relative(normalizedRoot, normalizedFile);
  if (relative && !relative.startsWith("..") && !path.posix.isAbsolute(relative)) {
    return "/" + relative;
  }
  // Outside the project root: use Vite's absolute-filesystem URL form.
  return "/@fs/" + normalizedFile.replace(/^\/+/, "");
}
