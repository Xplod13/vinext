/**
 * Tests for the normalised server-reference key used by the "use cache"
 * inline-directive transform.
 *
 * The key must match what @vitejs/plugin-rsc's "use server" transform
 * produces so that loadServerAction() can resolve the module at runtime.
 *
 * build key: sha256(toRelativeId(absoluteId)).hex.slice(0,12)
 *   where toRelativeId = normalizePath(path.relative(root, id))
 *   and   normalizePath = forward-slash conversion
 *
 * dev key:   id.slice(root.length)  (URL path served by Vite dev server)
 */
import { describe, expect, it } from "vite-plus/test";
import { createHash } from "node:crypto";
import path from "node:path";

// Replicate the helper from @vitejs/plugin-rsc (plugin-BK29Va7z.js).
function hashString(v: string): string {
  return createHash("sha256").update(v).digest().toString("hex").slice(0, 12);
}

// Replicate Vite's normalizePath (converts backslashes → forward slashes).
function normalizePath(p: string): string {
  return p.replace(/\\/g, "/");
}

// The exact formula used in vinext's use-cache transform for build mode.
function buildNormalizedRefKey(root: string, id: string): string {
  const relId = normalizePath(path.relative(root, id));
  return hashString(relId);
}

// The exact formula used in vinext's use-cache transform for dev mode.
function devNormalizedRefKey(root: string, id: string): string {
  if (id.startsWith(root + "/") || id.startsWith(root + "\\")) {
    return id.slice(root.length);
  }
  return id;
}

describe("use-cache inline function: build-mode normalised reference key", () => {
  const root = "/home/user/project";

  it("matches plugin-rsc hashString(toRelativeId) for a nested source file", () => {
    const id = "/home/user/project/src/app/actions.ts";
    const relId = "src/app/actions.ts";
    const expected = hashString(relId);
    expect(buildNormalizedRefKey(root, id)).toBe(expected);
  });

  it("matches for a file at the root", () => {
    const id = "/home/user/project/page.tsx";
    const expected = hashString("page.tsx");
    expect(buildNormalizedRefKey(root, id)).toBe(expected);
  });

  it("produces a 12-character hex string", () => {
    const id = "/home/user/project/app/page.tsx";
    const key = buildNormalizedRefKey(root, id);
    expect(key).toMatch(/^[0-9a-f]{12}$/);
  });

  it("different files produce different keys (no collisions for realistic paths)", () => {
    const files = [
      "/home/user/project/src/app/actions.ts",
      "/home/user/project/src/app/other-actions.ts",
      "/home/user/project/src/lib/data.ts",
      "/home/user/project/app/page.tsx",
    ];
    const keys = files.map((f) => buildNormalizedRefKey(root, f));
    const unique = new Set(keys);
    expect(unique.size).toBe(files.length);
  });

  it("is stable across calls (deterministic)", () => {
    const id = "/home/user/project/src/app/actions.ts";
    expect(buildNormalizedRefKey(root, id)).toBe(buildNormalizedRefKey(root, id));
  });
});

describe("use-cache inline function: dev-mode normalised reference key", () => {
  const root = "/home/user/project";

  it("strips root prefix leaving a /...-prefixed path", () => {
    const id = "/home/user/project/src/app/actions.ts";
    expect(devNormalizedRefKey(root, id)).toBe("/src/app/actions.ts");
  });

  it("handles files directly under root", () => {
    const id = "/home/user/project/page.tsx";
    expect(devNormalizedRefKey(root, id)).toBe("/page.tsx");
  });

  it("returns id unchanged for ids outside root (e.g. node_modules absolute path)", () => {
    const id = "/home/user/other-project/something.ts";
    expect(devNormalizedRefKey(root, id)).toBe(id);
  });
});
