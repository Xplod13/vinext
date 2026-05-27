/**
 * Tests for the request-context cache integration.
 *
 * vinext inspects the per-request ExecutionContext for a `.cache` object
 * with a `.purge({ tags })` method. When present, `revalidateTag()`,
 * `revalidatePath()`, and `updateTag()` fan out their invalidations to it
 * alongside the inner CacheHandler. No registration step is required —
 * any runtime that puts a compatible cache on `ctx` is supported.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { runWithExecutionContext } from "../packages/vinext/src/shims/request-context.js";
import {
  MemoryCacheHandler,
  revalidatePath,
  revalidateTag,
  setCacheHandler,
  updateTag,
} from "../packages/vinext/src/shims/cache.js";

type MockCache = { purge: ReturnType<typeof vi.fn> };

function makeCtx(opts?: { withCache?: boolean; throwOnPurge?: boolean }) {
  const cache: MockCache | undefined =
    opts?.withCache !== false
      ? {
          purge: vi.fn(async () => {
            if (opts?.throwOnPurge) throw new Error("purge failed");
          }),
        }
      : undefined;
  return { cache, waitUntil: vi.fn() };
}

describe("revalidate* → ctx.cache.purge fan-out", () => {
  beforeEach(() => {
    // Isolate the inner handler so handler counts are unaffected by prior tests.
    setCacheHandler(new MemoryCacheHandler());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("revalidateTag calls ctx.cache.purge with the tag", async () => {
    const ctx = makeCtx();
    await runWithExecutionContext(ctx, () => revalidateTag("posts"));
    expect(ctx.cache?.purge).toHaveBeenCalledWith({ tags: ["posts"] });
  });

  it("revalidatePath without type purges both `_N_T_<path>` and the bare path", async () => {
    const ctx = makeCtx();
    await runWithExecutionContext(ctx, () => revalidatePath("/blog/post-1"));
    // Both forms land in the response Cache-Tag header — they must both
    // be purged so the outer cache cannot keep serving a stale entry.
    expect(ctx.cache?.purge).toHaveBeenCalledWith({
      tags: ["_N_T_/blog/post-1", "/blog/post-1"],
    });
  });

  it("revalidatePath with type only purges the typed tag", async () => {
    const ctx = makeCtx();
    await runWithExecutionContext(ctx, () => revalidatePath("/blog/post-1", "page"));
    expect(ctx.cache?.purge).toHaveBeenCalledWith({ tags: ["_N_T_/blog/post-1/page"] });
  });

  it("updateTag purges the outer cache immediately", async () => {
    const ctx = makeCtx();
    await runWithExecutionContext(ctx, () => updateTag("featured"));
    expect(ctx.cache?.purge).toHaveBeenCalledWith({ tags: ["featured"] });
  });

  it("does nothing when the ExecutionContext has no .cache", async () => {
    const ctx = makeCtx({ withCache: false });
    // Must not throw — no binding to call.
    await runWithExecutionContext(ctx, () => revalidateTag("posts"));
  });

  it("ignores a non-function .cache.purge", async () => {
    const ctx = { cache: { purge: "not a function" }, waitUntil: vi.fn() } as never;
    await runWithExecutionContext(ctx, () => revalidateTag("posts"));
    // Nothing to assert — the test passes if no throw escapes.
  });

  it("works outside any ExecutionContext (Node dev)", async () => {
    // No `runWithExecutionContext` wrapper — getRequestExecutionContext()
    // returns null, the fan-out is a no-op, the inner handler still runs.
    await revalidateTag("posts");
  });

  it("swallows errors from ctx.cache.purge so revalidation stays atomic", async () => {
    const ctx = makeCtx({ throwOnPurge: true });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await runWithExecutionContext(ctx, () => revalidateTag("posts"));
    expect(errorSpy).toHaveBeenCalled();
  });
});
