/**
 * Unit tests for the "vinext:use-cache" transform's server-reference wrapping
 * of inline (function-level) "use cache" directives in the RSC environment.
 *
 * These call the plugin's transform hook directly (same pattern as
 * optimize-imports.test.ts) so they can exercise environment/manager
 * combinations that are impractical to reproduce through a full Vite server:
 *
 * 1. The manager-less fail-loud path: when the @vitejs/plugin-rsc manager is
 *    unavailable, wrapping must throw instead of emitting a
 *    serializable-but-unresolvable server reference (which would surface as a
 *    silent 404 on action POST in production).
 * 2. The happy path's reference key: hashString(toRelativeId(id)) in build.
 * 3. The documented divergence from Next.js: closure-captured variables are
 *    hoisted into plain `.bind(null, ...)` bound args — no encryption wrapper
 *    is emitted. (Next.js encrypts bound args by default. Pinned here at the
 *    transform level; the production-server and Playwright round-trip tests
 *    pin the runtime behavior.)
 */
import path from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vite-plus/test";
import type { Plugin } from "vite";
import vinext from "../packages/vinext/src/index.js";
import { APP_FIXTURE_DIR } from "./helpers.js";

// oxlint-disable-next-line typescript/no-explicit-any
function unwrapHook(hook: any): ((...args: any[]) => any) | undefined {
  return typeof hook === "function" ? hook : hook?.handler;
}

/** Instantiate vinext() and return its "vinext:use-cache" plugin. */
function getUseCachePlugin(): Plugin {
  // oxlint-disable-next-line typescript/no-explicit-any
  const rawPlugins = vinext({ appDir: APP_FIXTURE_DIR }) as any[];
  const plugin = rawPlugins
    .flat(Infinity)
    .find((p) => p && typeof p === "object" && p.name === "vinext:use-cache");
  expect(plugin).toBeDefined();
  return plugin as Plugin;
}

const moduleId = path.join(APP_FIXTURE_DIR, "app", "unit-test-inline-cache.tsx");

const inlineCacheCode = [
  `export async function getData() {`,
  `  "use cache";`,
  `  return 1;`,
  `}`,
].join("\n");

function fakeManager(root: string) {
  return {
    config: { root },
    toRelativeId: (id: string) => path.relative(root, id).split(path.sep).join("/"),
    serverReferenceMetaMap: {} as Record<string, unknown>,
  };
}

describe("vinext:use-cache inline transform (RSC server references)", () => {
  it("throws in the RSC build environment when the plugin-rsc manager is unavailable", async () => {
    // configResolved is intentionally NOT called: rscPluginApi stays null,
    // simulating a build where the "rsc:minimal" plugin (and its manager api)
    // is missing. Wrapping anyway would emit a reference that serializes into
    // the RSC payload but is never registered in the server-references
    // manifest — a silent prod 404 on action POST — so the transform must
    // fail loudly at build time instead.
    const plugin = getUseCachePlugin();
    const transform = unwrapHook(plugin.transform)!;

    await expect(
      transform.call(
        { environment: { name: "rsc", mode: "build", config: { root: APP_FIXTURE_DIR } } },
        inlineCacheCode,
        moduleId,
      ),
    ).rejects.toThrow(/plugin-rsc manager is unavailable/);
  });

  it("throws in the RSC dev environment when the plugin-rsc manager is unavailable", async () => {
    // Dev has the same failure shape: the dev-mode reference validation reads
    // serverReferenceMetaMap, which cannot be populated without the manager.
    const plugin = getUseCachePlugin();
    const transform = unwrapHook(plugin.transform)!;

    await expect(
      transform.call(
        { environment: { name: "rsc", mode: "dev", config: { root: APP_FIXTURE_DIR } } },
        inlineCacheCode,
        moduleId,
      ),
    ).rejects.toThrow(/plugin-rsc manager is unavailable/);
  });

  it("does not require the manager outside the RSC environment", async () => {
    // SSR/client environments wrap call sites with the cache runtime only —
    // no server-reference metadata is involved, so no manager is needed.
    const plugin = getUseCachePlugin();
    const transform = unwrapHook(plugin.transform)!;

    const result = await transform.call(
      { environment: { name: "ssr", mode: "build", config: { root: APP_FIXTURE_DIR } } },
      inlineCacheCode,
      moduleId,
    );
    expect(result).not.toBeNull();
    expect(result!.code).toContain("registerCachedFunction");
    expect(result!.code).not.toContain("registerServerReference");
  });

  it("wraps hoisted exports with the plugin-rsc build reference key when the manager is present", async () => {
    const plugin = getUseCachePlugin();
    const manager = fakeManager(APP_FIXTURE_DIR);
    const configResolved = unwrapHook(plugin.configResolved)!;
    configResolved.call(plugin, { plugins: [{ name: "rsc:minimal", api: { manager } }] });

    const transform = unwrapHook(plugin.transform)!;
    const result = await transform.call(
      { environment: { name: "rsc", mode: "build", config: { root: APP_FIXTURE_DIR } } },
      inlineCacheCode,
      moduleId,
    );
    expect(result).not.toBeNull();

    // Build key parity with plugin-rsc: hashString(toRelativeId(id)) where
    // hashString = sha256 → hex → first 12 chars.
    const expectedKey = createHash("sha256")
      .update(manager.toRelativeId(moduleId))
      .digest("hex")
      .slice(0, 12);
    expect(result!.code).toContain("__vinext_registerServerReference");
    expect(result!.code).toContain(JSON.stringify(expectedKey));

    // registerServerReference must be imported via the vinext
    // cache-server-reference shim (which re-exports it through the same bare
    // "@vitejs/plugin-rsc/react/rsc" specifier the cache runtime uses), NOT
    // via a file:// URL of the plugin-rsc package entry — the latter would
    // couple correctness to Vite normalising the file:// URL and the bare
    // import to a single module id.
    const importSpecifiers = [...result!.code.matchAll(/from "([^"]+)"/g)].map((m) => m[1]);
    expect(importSpecifiers).toContainEqual(
      expect.stringContaining("/shims/cache-server-reference"),
    );
    expect(importSpecifiers).not.toContainEqual(expect.stringContaining("@vitejs/plugin-rsc"));
  });

  it("emits closure-captured variables as plain (unencrypted) bound args", async () => {
    // Pins the documented Next.js divergence at the transform level: the
    // hoist transform is invoked without encode/decode options, so captured
    // variables appear verbatim in a `.bind(null, ...)` call site instead of
    // being encrypted like plugin-rsc's "use server" transform does. See the
    // "Known limitation" note in packages/vinext/src/index.ts and the README
    // "Known limitations" section. If encryption is implemented, update this
    // test alongside the round-trip tests.
    const plugin = getUseCachePlugin();
    const manager = fakeManager(APP_FIXTURE_DIR);
    const configResolved = unwrapHook(plugin.configResolved)!;
    configResolved.call(plugin, { plugins: [{ name: "rsc:minimal", api: { manager } }] });

    const closureCode = [
      `export async function CachedSection() {`,
      `  "use cache";`,
      `  const capturedSecret = "do-not-leak";`,
      `  const getMessage = async () => {`,
      `    "use cache";`,
      `    return "message:" + capturedSecret;`,
      `  };`,
      `  return getMessage;`,
      `}`,
    ].join("\n");

    const transform = unwrapHook(plugin.transform)!;
    const result = await transform.call(
      { environment: { name: "rsc", mode: "build", config: { root: APP_FIXTURE_DIR } } },
      closureCode,
      moduleId,
    );
    expect(result).not.toBeNull();
    // The captured variable is passed as a raw bind arg — no encrypt wrapper.
    expect(result!.code).toMatch(/\.bind\(null,\s*capturedSecret\)/);
  });
});
