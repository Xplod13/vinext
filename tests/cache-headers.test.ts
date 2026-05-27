/**
 * Unit tests for the cache header helpers shared by the App Router and the
 * Pages Router response builders. `applyCacheTagHeader` formats the
 * `Cache-Tag` header that the Cloudflare Workers Cache reads for tag-based
 * purging — its behaviour around budgets, dedupe, and empty inputs is what
 * the page/route handler responses rely on.
 */

import { describe, it, expect } from "vite-plus/test";

import {
  applyCacheTagHeader,
  setCacheStateHeaders,
} from "../packages/vinext/src/server/cache-headers.js";

describe("applyCacheTagHeader", () => {
  it("joins tags with commas and writes a Cache-Tag header", () => {
    const headers = new Headers();
    applyCacheTagHeader(headers, ["a", "b", "c"]);
    expect(headers.get("Cache-Tag")).toBe("a,b,c");
  });

  it("does nothing when the tag list is empty", () => {
    const headers = new Headers();
    applyCacheTagHeader(headers, []);
    expect(headers.has("Cache-Tag")).toBe(false);
  });

  it("dedupes repeated tags", () => {
    const headers = new Headers();
    applyCacheTagHeader(headers, ["a", "a", "b", "b", "c"]);
    expect(headers.get("Cache-Tag")).toBe("a,b,c");
  });

  it("skips empty-string entries defensively", () => {
    const headers = new Headers();
    applyCacheTagHeader(headers, ["", "a", "", "b"]);
    expect(headers.get("Cache-Tag")).toBe("a,b");
  });

  it("truncates the rendered list at the byte budget", () => {
    // 1 KiB tag * 20 ≈ 20 KiB, which exceeds the 15 KiB budget. The header
    // must not exceed the budget — the runtime would silently truncate
    // anything over 16 KiB, so we cap ourselves first.
    const bigTag = "x".repeat(1024);
    const headers = new Headers();
    applyCacheTagHeader(
      headers,
      Array.from({ length: 20 }, (_, i) => `${bigTag}${i}`),
    );
    const value = headers.get("Cache-Tag") ?? "";
    expect(value.length).toBeGreaterThan(0);
    expect(value.length).toBeLessThanOrEqual(15 * 1024);
  });

  it("does not overwrite an existing Cache-Tag header when no new tags would be written", () => {
    const headers = new Headers({ "Cache-Tag": "existing" });
    applyCacheTagHeader(headers, []);
    expect(headers.get("Cache-Tag")).toBe("existing");
  });
});

describe("setCacheStateHeaders", () => {
  it("emits both vinext and next.js cache state headers", () => {
    const headers = new Headers();
    setCacheStateHeaders(headers, "HIT");
    expect(headers.get("X-Vinext-Cache")).toBe("HIT");
    expect(headers.get("x-nextjs-cache")).toBe("HIT");
  });

  it("maps STATIC to HIT on the next.js header", () => {
    const headers = new Headers();
    setCacheStateHeaders(headers, "STATIC");
    expect(headers.get("X-Vinext-Cache")).toBe("STATIC");
    expect(headers.get("x-nextjs-cache")).toBe("HIT");
  });
});
