/**
 * `experimental.inlineCss` — App Router CSS inlining.
 *
 * When `next.config` sets `experimental.inlineCss: true`, App Router pages
 * must serve their CSS as inline `<style>` tags in `<head>` instead of
 * `<link rel="stylesheet" href="...">` references. This matches Next.js's
 * behavior for the same flag — see
 * `.nextjs-ref/test/e2e/app-dir/app-inline-css/index.test.ts` and
 * https://nextjs.org/docs/app/api-reference/config/next-config-js/inlineCss
 *
 * Ported from Next.js:
 *   test/e2e/app-dir/app-inline-css/index.test.ts
 *
 * @see https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/app-inline-css
 *
 * Production only — Next.js disables inlining in dev because HMR keeps
 * mutating the document `<style>` set, which conflicts with the inlined
 * ones (`(isNextDev ? describe.skip : describe)('Production only', …)` in
 * the source test).
 *
 * Related to vinext issue #1499.
 */

import { describe, it, expect, afterAll, beforeEach } from "vite-plus/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createBuilder } from "vite";
import vinext from "../packages/vinext/src/index.js";
import { setInlineCssMap } from "../packages/vinext/src/server/app-inline-css.js";

const ROOT_NODE_MODULES = path.resolve(import.meta.dirname, "../node_modules");

async function makeInlineCssFixture(opts: { inlineCss: boolean }): Promise<string> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-inline-css-"));
  await fs.symlink(ROOT_NODE_MODULES, path.join(tmpDir, "node_modules"), "junction");

  const appDir = path.join(tmpDir, "app");
  await fs.mkdir(appDir, { recursive: true });

  // The CSS content needs a distinctive marker that survives Vite's CSS
  // minifier — comments are stripped, but a class selector inside an
  // otherwise-valid rule isn't.
  await fs.writeFile(
    path.join(appDir, "global.css"),
    ".vinext-inline-css-marker { color: rgb(255, 255, 0); }\n",
  );

  await fs.writeFile(
    path.join(appDir, "layout.tsx"),
    `import "./global.css";\nexport default function RootLayout({ children }: { children: React.ReactNode }) {\n  return (<html lang="en"><body>{children}</body></html>);\n}\n`,
  );

  await fs.writeFile(
    path.join(appDir, "page.tsx"),
    `export default function Home() {\n  return <p id="home">Hello inline CSS</p>;\n}\n`,
  );

  // Tell Node to load `.js` chunks as ESM. `next.config.js` ships as CJS,
  // so it must be renamed to `next.config.cjs` (or use a `.mjs`). Vite
  // labels generated chunks with `.js` and relies on the fixture's
  // package.json to declare them as modules.
  await fs.writeFile(
    path.join(tmpDir, "package.json"),
    JSON.stringify({ name: "vinext-inline-css-fixture", private: true, type: "module" }),
  );

  await fs.writeFile(
    path.join(tmpDir, "next.config.cjs"),
    `module.exports = ${JSON.stringify({ experimental: { inlineCss: opts.inlineCss } }, null, 2)};\n`,
  );

  return tmpDir;
}

async function buildFixture(fixtureDir: string): Promise<{ outDir: string }> {
  // Build in-place into `<fixtureDir>/dist/` so the standard production
  // layout (`dist/server/index.js`, `dist/client/_next/static/...`) lines
  // up with what `startProdServer` expects. Mirrors
  // `tests/invalid-static-asset-404.test.ts`.
  const builder = await createBuilder({
    root: fixtureDir,
    configFile: false,
    plugins: [vinext({ appDir: fixtureDir })],
    logLevel: "warn",
  });
  await builder.buildApp();

  const outDir = path.join(fixtureDir, "dist");
  const rscEntry = path.join(outDir, "server", "index.js");
  try {
    await fs.access(rscEntry);
  } catch {
    const listing = (await fs.readdir(outDir)).join(", ");
    throw new Error(`Build did not produce ${rscEntry}; got: ${listing}`);
  }

  return { outDir };
}

async function fetchHomeHtml(outDir: string): Promise<string> {
  const { startProdServer } = await import("../packages/vinext/src/server/prod-server.js");
  const { server } = await startProdServer({
    port: 0,
    outDir,
    noCompression: true,
  });
  try {
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    const res = await fetch(`http://localhost:${port}/`);
    expect(res.status).toBe(200);
    return await res.text();
  } finally {
    server.close();
  }
}

describe("App Router experimental.inlineCss (#1499)", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterAll(async () => {
    for (const c of cleanups) await c().catch(() => {});
  });

  // The inline-CSS map lives on `globalThis` — clear it between cases so
  // the no-inlining test isn't accidentally serviced by the prior case's
  // map (and vice-versa).
  beforeEach(() => setInlineCssMap(undefined));

  // We accept either layout the upstream RSC plugin chooses: the bare
  // `<link rel="stylesheet" href="...">` (older releases) or one that
  // additionally carries `data-rsc-css-href` (current). Both forms must
  // disappear when inlining is on.
  const STYLESHEET_LINK_RE = /<link[^>]*\brel="stylesheet"[^>]*>/i;

  it("inlines CSS as <style> in <head> when experimental.inlineCss is true", async () => {
    const fixture = await makeInlineCssFixture({ inlineCss: true });
    const built = await buildFixture(fixture);
    cleanups.push(async () => {
      await fs.rm(fixture, { recursive: true, force: true });
      await fs.rm(built.outDir, { recursive: true, force: true });
    });

    const html = await fetchHomeHtml(built.outDir);

    // The page CSS must appear inside a <style> tag in <head>.
    expect(html).toContain("<style");
    expect(html).toContain(".vinext-inline-css-marker");

    // And the stylesheet link tag the RSC plugin would normally emit must
    // not be present (font / user-authored <link rel="stylesheet"> tags
    // remain valid, but this fixture has none).
    expect(html).not.toMatch(STYLESHEET_LINK_RE);
  }, 180_000);

  it('emits <link rel="stylesheet"> when experimental.inlineCss is not set', async () => {
    const fixture = await makeInlineCssFixture({ inlineCss: false });
    const built = await buildFixture(fixture);
    cleanups.push(async () => {
      await fs.rm(fixture, { recursive: true, force: true });
      await fs.rm(built.outDir, { recursive: true, force: true });
    });

    const html = await fetchHomeHtml(built.outDir);

    // Baseline sanity check: without the flag, vinext keeps the link tag
    // and does not inline the CSS contents.
    expect(html).toMatch(STYLESHEET_LINK_RE);
    expect(html).not.toContain(".vinext-inline-css-marker");
  }, 180_000);
});
