/**
 * Shared helper for `experimental.inlineCss`.
 *
 * Walks a directory looking for `.css` files and returns a URL→content
 * map keyed on the URL `@vitejs/plugin-rsc` will emit in `data-rsc-css-href`
 * (Vite's `base` is `/` by default; the URL is therefore `/<relativePath>`).
 *
 * Two callers:
 *   - `vinext:cloudflare-build` invokes this at build time to inline the map
 *     into the Worker bundle.
 *   - The Node prod server invokes this once at startup, before any request
 *     is served — synchronous I/O is fine there because the server is not
 *     yet accepting connections.
 *
 * Errors reading individual files are logged but not fatal — a partial map
 * is better than a build/startup failure, and the SSR transform falls back to
 * the original `<link rel="stylesheet">` tag for any URL not in the map.
 */
import fs from "node:fs";
import path from "node:path";

export function collectInlineCssMap(clientDir: string): Record<string, string> {
  const map: Record<string, string> = {};

  function walk(dir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // Skip Vite's internal metadata directory; nothing inside is
        // served at request time and we don't want to inline source maps.
        if (entry.name === ".vite") continue;
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith(".css")) continue;
      try {
        const content = fs.readFileSync(full, "utf-8");
        const relative = path.relative(clientDir, full).split(path.sep).join("/");
        map["/" + relative] = content;
      } catch (error) {
        console.warn("[vinext] failed to read inline-CSS source:", full, error);
      }
    }
  }

  walk(clientDir);
  return map;
}
