/**
 * Regression test for cloudflare/vinext#1824.
 *
 * Edge/worker routes that reference static assets via
 * `new URL("./asset", import.meta.url)` and `fetch(url)` failed at runtime:
 * Vite's built-in `vite:asset-import-meta-url` plugin only runs in the
 * `client` environment, so the URL was left untransformed, and on Cloudflare
 * Workers `import.meta.url` is the literal string `"worker"` — `new URL(...)`
 * then throws `TypeError: Invalid URL`. The whole upstream
 * `edge-compiler-can-import-blob-assets` suite (5 tests) was red.
 *
 * `vinext:edge-asset-import-meta-url` rewrites the expression to an inline
 * `data:` URL so the asset is fetchable in both workerd and Node. This test
 * drives the plugin's `transform` hook directly (mirroring the
 * `edge.js` fixture from the upstream suite) and asserts the rewrite.
 */

import { describe, it, expect, beforeAll, afterAll } from "vite-plus/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vinext from "../packages/vinext/src/index.js";
import type { Plugin } from "vite";

function getPlugin(): Plugin {
  const plugins = vinext() as Plugin[];
  const plugin = plugins.find((p) => p.name === "vinext:edge-asset-import-meta-url");
  if (!plugin) throw new Error("vinext:edge-asset-import-meta-url plugin not found");
  return plugin;
}

function transformHandler(plugin: Plugin): (...args: any[]) => any {
  const t = plugin.transform as any;
  return typeof t === "function" ? t : t.handler;
}

// Minimal `this` context for the transform hook. `environment.config.consumer`
// is "server" so applyToEnvironment would admit it; isBuild defaults to false
// (we don't call configResolved) which disables the cache — fine for a test.
function makeCtx(resolveMap: Record<string, string> = {}) {
  return {
    environment: { name: "rsc", config: { consumer: "server" } },
    async resolve(spec: string) {
      const id = resolveMap[spec];
      return id ? { id } : null;
    },
  };
}

let tmpDir: string;
let routePath: string;

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-edge-asset-"));
  const srcDir = path.join(tmpDir, "src");
  const apiDir = path.join(tmpDir, "pages", "api");
  await fs.mkdir(srcDir, { recursive: true });
  await fs.mkdir(apiDir, { recursive: true });

  await fs.writeFile(path.join(srcDir, "text-file.txt"), "Hello, from text-file.txt!");
  await fs.writeFile(
    path.join(srcDir, "vercel.png"),
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01, 0x02]),
  );
  await fs.writeFile(path.join(tmpDir, "world.json"), '{ "i am": "a node dependency" }');

  routePath = path.join(apiDir, "edge.js");
});

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

describe("vinext:edge-asset-import-meta-url", () => {
  it("rewrites a relative text asset URL to a fetchable data: URL", async () => {
    const plugin = getPlugin();
    const code = [
      "const url = new URL('../../src/text-file.txt', import.meta.url)",
      "return fetch(url)",
    ].join("\n");

    const result = await transformHandler(plugin).call(makeCtx(), code, routePath);
    expect(result, "expected the relative URL to be rewritten").not.toBeNull();

    const expected =
      "data:text/plain;base64," + Buffer.from("Hello, from text-file.txt!").toString("base64");
    expect(result.code).toContain(`new URL(${JSON.stringify(expected)})`);
    // The runtime no longer touches the (string "worker") import.meta.url for
    // this expression.
    expect(result.code).not.toContain("import.meta.url");

    // The inlined data URL round-trips to the original bytes.
    const decoded = Buffer.from(expected.split(",")[1]!, "base64").toString("utf8");
    expect(decoded).toBe("Hello, from text-file.txt!");
  });

  it("inlines a binary image asset with the correct mime type", async () => {
    const plugin = getPlugin();
    const code = "const url = new URL('../../src/vercel.png', import.meta.url); fetch(url)";
    const result = await transformHandler(plugin).call(makeCtx(), code, routePath);
    expect(result).not.toBeNull();

    const expected =
      "data:image/png;base64," +
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01, 0x02]).toString("base64");
    expect(result.code).toContain(`new URL(${JSON.stringify(expected)})`);
  });

  it("resolves bare specifiers (node_modules assets) via the bundler resolver", async () => {
    const plugin = getPlugin();
    const worldJson = path.join(tmpDir, "world.json");
    const code = "const url = new URL('my-pkg/hello/world.json', import.meta.url); fetch(url)";
    const ctx = makeCtx({ "my-pkg/hello/world.json": worldJson });

    const result = await transformHandler(plugin).call(ctx, code, routePath);
    expect(result, "expected the bare-specifier URL to be rewritten").not.toBeNull();

    const expected =
      "data:application/json;base64," +
      Buffer.from('{ "i am": "a node dependency" }').toString("base64");
    expect(result.code).toContain(`new URL(${JSON.stringify(expected)})`);

    const decoded = JSON.parse(Buffer.from(expected.split(",")[1]!, "base64").toString("utf8"));
    expect(decoded).toEqual({ "i am": "a node dependency" });
  });

  it("leaves absolute/remote URLs untouched", async () => {
    const plugin = getPlugin();
    // Single-arg remote URL and a two-arg base form — neither references a
    // build-time asset, so the plugin must not rewrite them.
    const code = [
      "const a = new URL('https://example.vercel.sh')",
      "const b = new URL('/', 'https://example.vercel.sh')",
    ].join("\n");
    const result = await transformHandler(plugin).call(makeCtx(), code, routePath);
    expect(result).toBeNull();
  });

  it("leaves the expression untouched when the file does not exist", async () => {
    const plugin = getPlugin();
    const code = "const url = new URL('../../src/missing.bin', import.meta.url)";
    const result = await transformHandler(plugin).call(makeCtx(), code, routePath);
    expect(result).toBeNull();
  });

  it("does not run in the client environment", () => {
    const plugin = getPlugin();
    const applyToEnvironment = plugin.applyToEnvironment as (env: any) => boolean;
    expect(applyToEnvironment({ config: { consumer: "client" } })).toBe(false);
    expect(applyToEnvironment({ config: { consumer: "server" } })).toBe(true);
  });
});
