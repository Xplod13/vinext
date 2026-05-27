import { NEXTJS_CACHE_HEADER, VINEXT_CACHE_HEADER } from "./headers.js";

type VinextCacheState = "HIT" | "MISS" | "STALE" | "STATIC";
type NextJsCacheState = "HIT" | "MISS" | "STALE";

function toNextJsCacheState(cacheState: VinextCacheState): NextJsCacheState {
  return cacheState === "STATIC" ? "HIT" : cacheState;
}

export function setCacheStateHeaders(headers: Headers, cacheState: VinextCacheState): void {
  headers.set(VINEXT_CACHE_HEADER, cacheState);
  headers.set(NEXTJS_CACHE_HEADER, toNextJsCacheState(cacheState));
}

export function buildCacheStateHeaders(cacheState: VinextCacheState): Record<string, string> {
  return {
    [VINEXT_CACHE_HEADER]: cacheState,
    [NEXTJS_CACHE_HEADER]: toNextJsCacheState(cacheState),
  };
}

/**
 * Cloudflare Workers Cache and other shared HTTP caches honour the
 * `Cache-Tag` response header for tag-based purging. Tags are joined with
 * commas per Cloudflare's `Cache-Tag` format. We strip empty entries
 * defensively and cap the rendered header to ~15KiB so a runaway tag set
 * cannot exceed Workers's response header limits (the platform truncates
 * silently beyond 16KiB).
 *
 * Tags must already be ASCII-safe (see `encodeCacheTag`). This helper does
 * not re-encode — callers own the canonicalisation pass.
 */
const CACHE_TAG_HEADER_BYTE_BUDGET = 15 * 1024;

export function applyCacheTagHeader(headers: Headers, tags: readonly string[]): void {
  if (tags.length === 0) return;
  const seen = new Set<string>();
  const out: string[] = [];
  let length = 0;
  for (const tag of tags) {
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    // +1 for the separating comma between entries (skipped on the first).
    const entryLength = tag.length + (out.length > 0 ? 1 : 0);
    if (length + entryLength > CACHE_TAG_HEADER_BYTE_BUDGET) break;
    out.push(tag);
    length += entryLength;
  }
  if (out.length === 0) return;
  headers.set("Cache-Tag", out.join(","));
}
