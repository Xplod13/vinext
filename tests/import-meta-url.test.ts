/**
 * `import.meta.url` parity test.
 *
 * Ported from Next.js: test/e2e/import-meta/import-meta.test.ts
 * https://github.com/vercel/next.js/blob/canary/test/e2e/import-meta/import-meta.test.ts
 *
 * Next.js (both Turbopack and Webpack) preserves the user's source path so a
 * page's `import.meta.url` is `file:///<abs-path>/pages/index.tsx`. vinext
 * bundles all server modules into a single entry; without explicit handling
 * the runtime `import.meta.url` resolves to the bundled entry path, breaking
 * `new URL('./data.json', import.meta.url)`-style resolution and any code
 * that introspects the source filename.
 *
 * The fix is a Vite transform that substitutes `import.meta.url` with the
 * user source file URL string before bundling. This test asserts the
 * substitution happens in both dev (where Vite already does it per-module)
 * and in the bundled production output (the cloudflare/vinext#1505 regression
 * case).
 *
 * Regression for cloudflare/vinext#1505.
 */
import { describe, it, expect, beforeAll, afterAll } from "vite-plus/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "vite";
import vinext from "../packages/vinext/src/index.js";
import type { ViteDevServer } from "vite-plus";
import { pathToFileURL } from "node:url";
import { rewriteImportMetaUrl } from "../packages/vinext/src/plugins/import-meta-url.js";
import { PAGES_FIXTURE_DIR, startFixtureServer, fetchHtml } from "./helpers.js";

function extractTestData(html: string): { url: string } {
  // <div id="test-data">…JSON…</div>. React's SSR escapes `"` as `&quot;` and
  // may insert comment nodes — decode and strip both before parsing.
  const match = html.match(/<div[^>]*id="test-data"[^>]*>([\s\S]*?)<\/div>/);
  if (!match) {
    throw new Error(`#test-data not found in HTML: ${html.slice(0, 200)}`);
  }
  // Strip HTML comments in a loop until none remain — guards against
  // accidentally reintroducing a "<!--" sequence after the first pass.
  let stripped = match[1];
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const next = stripped.replace(/<!--[\s\S]*?-->/g, "");
    if (next === stripped) break;
    stripped = next;
  }
  // Single-pass entity decode to avoid the double-unescape pitfall
  // (e.g. "&amp;lt;" must NOT become "<"). All known named entities are
  // matched in one regex; the replacer picks the canonical decoded form.
  const ENTITIES: Record<string, string> = {
    "&quot;": '"',
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
  };
  const decoded = stripped.replace(/&(?:quot|amp|lt|gt);/g, (m) => ENTITIES[m] ?? m);
  return JSON.parse(decoded);
}

describe("rewriteImportMetaUrl (unit)", () => {
  const FILE_URL = "file:///abs/pages/index.tsx";

  it("returns null when there is no occurrence", () => {
    expect(rewriteImportMetaUrl("const x = 1;\n", FILE_URL)).toBeNull();
  });

  it("replaces a bare import.meta.url with the JSON-stringified URL", () => {
    const out = rewriteImportMetaUrl("const u = import.meta.url;", FILE_URL);
    expect(out).toBe(`const u = ${JSON.stringify(FILE_URL)};`);
  });

  it("replaces every occurrence", () => {
    const code = "a(import.meta.url); b(import.meta.url);";
    const out = rewriteImportMetaUrl(code, FILE_URL);
    const literal = JSON.stringify(FILE_URL);
    expect(out).toBe(`a(${literal}); b(${literal});`);
  });

  it("does not rewrite identifiers that merely start with import.meta.url", () => {
    // e.g. `import.meta.urls` (if it ever existed) — the trailing identifier
    // character means this is a different member access, not `.url`.
    const code = "const x = import.meta.urls;";
    expect(rewriteImportMetaUrl(code, FILE_URL)).toBeNull();
  });

  it("preserves other import.meta references", () => {
    const code = "const a = import.meta.url; const b = import.meta.env.DEV;";
    const out = rewriteImportMetaUrl(code, FILE_URL);
    expect(out).toBe(`const a = ${JSON.stringify(FILE_URL)}; const b = import.meta.env.DEV;`);
  });
});

describe("import.meta.url (Pages Router, dev)", () => {
  let server: ViteDevServer;
  let baseUrl: string;

  beforeAll(async () => {
    ({ server, baseUrl } = await startFixtureServer(PAGES_FIXTURE_DIR));
  }, 30000);

  afterAll(async () => {
    await server?.close();
  });

  it("resolves to the user's source file URL on the server (not the bundled entry)", async () => {
    const { res, html } = await fetchHtml(baseUrl, "/import-meta-url");
    expect(res.status).toBe(200);

    const data = extractTestData(html);
    // Mirrors Next.js parity: file:///<...>/pages/import-meta-url.tsx
    expect(data.url).toMatch(/^file:\/\//);
    expect(data.url.endsWith("/pages/import-meta-url.tsx")).toBe(true);

    // Anchor to the fixture root so a wrong substitution (e.g. the bundled
    // entry path) is also caught.
    const expectedFileUrl = pathToFileURL(
      path.join(PAGES_FIXTURE_DIR, "pages", "import-meta-url.tsx"),
    ).href;
    expect(data.url).toBe(expectedFileUrl);
  });
});

describe("import.meta.url (Pages Router, production build)", () => {
  // The regression case from cloudflare/vinext#1505: in production, Rolldown
  // collapses every server module into one entry file. Without explicit
  // handling, `import.meta.url` at runtime resolves to the bundled entry
  // path, not the user's source file. This test asserts the build embeds
  // the user source path as a literal string in the bundle so the runtime
  // value matches Next.js parity.
  let bundlePath: string;
  let outDir: string;

  beforeAll(async () => {
    outDir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-import-meta-url-build-"));
    await build({
      root: PAGES_FIXTURE_DIR,
      configFile: false,
      plugins: [vinext({ disableAppRouter: true })],
      logLevel: "silent",
      build: {
        outDir,
        emptyOutDir: true,
        ssr: "virtual:vinext-server-entry",
        rollupOptions: { output: { entryFileNames: "entry.js" } },
      },
    });
    bundlePath = path.join(outDir, "entry.js");
  }, 120_000);

  afterAll(() => {
    if (outDir) fs.rmSync(outDir, { recursive: true, force: true });
  });

  it("substitutes import.meta.url in the bundle with the user source file URL", async () => {
    const bundle = fs.readFileSync(bundlePath, "utf-8");
    const expectedFileUrl = pathToFileURL(
      path.join(PAGES_FIXTURE_DIR, "pages", "import-meta-url.tsx"),
    ).href;

    // The bundle must contain the user source file URL as a literal so the
    // runtime `import.meta.url` evaluation in the page module yields the
    // Next.js-parity value. Asserting on bundle text (rather than running
    // the bundle) keeps the test fast and avoids spinning a prod server.
    expect(
      bundle.includes(expectedFileUrl),
      `expected bundle to embed the page's source file URL (${expectedFileUrl}). ` +
        `Substitution likely missing.`,
    ).toBe(true);
  });
});
