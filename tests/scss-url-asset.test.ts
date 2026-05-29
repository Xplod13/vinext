/**
 * Tests that CSS/SCSS `url(...)` asset references are emitted as hashed
 * files under `/_next/static/media/` rather than inlined as `data:` URIs.
 *
 * Next.js routes every `url(./foo.svg)` reference in a stylesheet through
 * webpack's `asset/resource` loader, which *always* emits the asset to a
 * hashed file under `_next/static/media/` and rewrites the `url()` to point
 * at it — it never inlines as a data URI (see
 * `.nextjs-ref/packages/next/src/build/webpack/config/blocks/css/index.ts`,
 * the `type: 'asset/resource'` rule). The upstream SCSS suites assert exactly
 * this:
 *
 *   url("/_next/static/media/dark.<HASH>.svg")
 *
 * Vite, by contrast, inlines assets smaller than `build.assetsInlineLimit`
 * (4096 bytes by default) as `data:` URIs. A small `.svg` referenced from
 * SCSS therefore came out as `url("data:image/svg+xml,...")`, diverging from
 * Next.js and breaking the `app-dir/scss/url-global` and
 * `app-dir/scss/url-global-partial` deploy-suite tests.
 *
 * vinext sets `build.assetsInlineLimit: 0` and an `assetFileNames` template
 * routing media assets into the `media/` subdirectory so the emitted URL and
 * on-disk layout match Next.js's `_next/static/media/<name>.<HASH>.<ext>`.
 *
 * Ported from Next.js:
 *   test/e2e/app-dir/scss/url-global/url-global.test.ts
 *   test/e2e/app-dir/scss/url-global-partial/url-global-partial.test.ts
 *
 * Closes: https://github.com/cloudflare/vinext/issues/1450
 */

import { describe, it, expect } from "vite-plus/test";
import { build } from "vite-plus";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vinext from "../packages/vinext/src/index.js";

// SCSS preprocessing requires the optional `sass` peer dependency. Skip the
// suite when it is not installed (matches tests/scss.test.ts).
let sassAvailable = false;
try {
  // @ts-ignore Optional peer dependency, not declared in this repo
  await import("sass");
  sassAvailable = true;
} catch {
  sassAvailable = false;
}

const describeIfSass = sassAvailable ? describe : describe.skip;

const ROOT_NODE_MODULES = path.resolve(import.meta.dirname, "../node_modules");

// A tiny inline SVG. At ~120 bytes it sits well under Vite's default 4096-byte
// inline threshold, so without `assetsInlineLimit: 0` Vite would inline it as
// a `data:` URI — the exact regression this test guards against.
const DARK_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect fill="#222" width="1" height="1"/></svg>\n';

async function makeFixture(): Promise<string> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-scss-url-"));
  await fs.symlink(ROOT_NODE_MODULES, path.join(tmpDir, "node_modules"), "junction");

  const stylesDir = path.join(tmpDir, "styles");
  await fs.mkdir(stylesDir, { recursive: true });
  await fs.writeFile(path.join(stylesDir, "dark.svg"), DARK_SVG);
  await fs.writeFile(
    path.join(stylesDir, "global.scss"),
    "$var: red;\n.red-text {\n  color: $var;\n  background-image: url('./dark.svg');\n}\n",
  );

  const pagesDir = path.join(tmpDir, "pages");
  await fs.mkdir(pagesDir, { recursive: true });
  await fs.writeFile(
    path.join(pagesDir, "_app.tsx"),
    'import "../styles/global.scss";\n' +
      "export default function App({ Component, pageProps }: any) {\n" +
      "  return <Component {...pageProps} />;\n" +
      "}\n",
  );
  await fs.writeFile(
    path.join(pagesDir, "index.tsx"),
    "export default function Home() {\n" +
      '  return <div className="red-text">SCSS url() test</div>;\n' +
      "}\n",
  );

  return tmpDir;
}

async function readAllFiles(dir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const entries = await fs.readdir(dir, { withFileTypes: true, recursive: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const parent =
      (entry as { parentPath?: string; path?: string }).parentPath ??
      (entry as { path?: string }).path ??
      dir;
    out.set(path.join(parent, entry.name), entry.name);
  }
  return out;
}

describeIfSass("SCSS url() asset emission", () => {
  it("emits url() references as hashed files under _next/static/media/ (not data: URIs)", async () => {
    const tmpDir = await makeFixture();
    const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-scss-url-out-"));
    try {
      const clientDir = path.join(outDir, "client");
      await build({
        root: tmpDir,
        configFile: false,
        plugins: [vinext({ disableAppRouter: true })],
        logLevel: "silent",
        build: {
          outDir: clientDir,
          manifest: true,
          ssrManifest: true,
          rollupOptions: { input: "virtual:vinext-client-entry" },
        },
      });

      const files = await readAllFiles(clientDir);

      // Locate the compiled stylesheet.
      const cssFiles = [...files.keys()].filter((p) => p.endsWith(".css"));
      expect(cssFiles.length).toBeGreaterThan(0);
      const allCss = (await Promise.all(cssFiles.map((p) => fs.readFile(p, "utf8")))).join("\n");

      // The SVG must NOT be inlined as a data URI...
      expect(allCss).not.toMatch(/url\(\s*["']?data:/);

      // ...it must be rewritten to a `/_next/static/media/dark.<hash>.svg` URL.
      expect(allCss).toMatch(
        /url\(\s*["']?\/_next\/static\/media\/dark\.[A-Za-z0-9_-]+\.svg["']?\s*\)/,
      );

      // And the referenced asset must actually exist on disk under that path.
      const mediaSvg = [...files.keys()].find(
        (p) =>
          /[/\\]_next[/\\]static[/\\]media[/\\]/.test(p) && /dark\.[A-Za-z0-9_-]+\.svg$/.test(p),
      );
      expect(mediaSvg, "expected emitted dark.<hash>.svg under _next/static/media/").toBeTruthy();
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      await fs.rm(outDir, { recursive: true, force: true }).catch(() => {});
    }
  }, 60_000);
});
