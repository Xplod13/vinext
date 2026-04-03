import type { NextI18nConfig } from "../config/next-config.js";
import type { ISRCacheEntry } from "./isr-cache.js";
import type { RouteHandlerMiddlewareContext } from "./app-route-handler-response.js";
import {
  applyRouteHandlerMiddlewareContext,
  buildRouteHandlerCachedResponse,
} from "./app-route-handler-response.js";
import {
  type AppRouteDebugLogger,
  type AppRouteDynamicUsageFn,
  type AppRouteHandlerFunction,
  type AppRouteParams,
  type MarkAppRouteDynamicUsageFn,
  type RouteHandlerCacheSetter,
} from "./app-route-handler-execution.js";

type RouteHandlerCacheGetter = (key: string) => Promise<ISRCacheEntry | null>;
type RouteHandlerBackgroundRegenerator = (key: string, renderFn: () => Promise<void>) => void;
type RouteHandlerRevalidationContextRunner = (renderFn: () => Promise<void>) => Promise<void>;

export type ReadAppRouteHandlerCacheOptions = {
  basePath?: string;
  buildPageCacheTags: (pathname: string, extraTags: string[]) => string[];
  cleanPathname: string;
  clearRequestContext: () => void;
  consumeDynamicUsage: AppRouteDynamicUsageFn;
  getCollectedFetchTags: () => string[];
  handlerFn: AppRouteHandlerFunction;
  i18n?: NextI18nConfig | null;
  isAutoHead: boolean;
  isrDebug?: AppRouteDebugLogger;
  isrGet: RouteHandlerCacheGetter;
  isrRouteKey: (pathname: string) => string;
  isrSet: RouteHandlerCacheSetter;
  markDynamicUsage: MarkAppRouteDynamicUsageFn;
  middlewareContext: RouteHandlerMiddlewareContext;
  params: AppRouteParams;
  requestUrl: string;
  revalidateSearchParams: URLSearchParams;
  revalidateSeconds: number;
  routePattern: string;
  runInRevalidationContext: RouteHandlerRevalidationContextRunner;
  scheduleBackgroundRegeneration: RouteHandlerBackgroundRegenerator;
  setNavigationContext: (
    context: {
      pathname: string;
      searchParams: URLSearchParams;
      params: AppRouteParams;
    } | null,
  ) => void;
};

function getCachedAppRouteValue(entry: ISRCacheEntry | null) {
  return entry?.value.value && entry.value.value.kind === "APP_ROUTE" ? entry.value.value : null;
}

export async function readAppRouteHandlerCacheResponse(
  options: ReadAppRouteHandlerCacheOptions,
): Promise<Response | null> {
  const routeKey = options.isrRouteKey(options.cleanPathname);

  try {
    const cached = await options.isrGet(routeKey);
    const cachedValue = getCachedAppRouteValue(cached);

    if (cachedValue && !cached?.isStale) {
      options.isrDebug?.("HIT (route)", options.cleanPathname);
      options.clearRequestContext();
      return applyRouteHandlerMiddlewareContext(
        buildRouteHandlerCachedResponse(cachedValue, {
          cacheState: "HIT",
          isHead: options.isAutoHead,
          revalidateSeconds: options.revalidateSeconds,
        }),
        options.middlewareContext,
      );
    }

    if (cached?.isStale && cachedValue) {
      // Route handlers re-render synchronously on expiry (unlike pages which use
      // stale-while-revalidate). Returning null here causes the caller to fall
      // through to __executeAppRouteHandler which runs the handler and updates
      // the cache, then returns fresh data. This matches Next.js behavior where
      // `fetch /route-handler` after the TTL returns fresh data on the same request.
      options.isrDebug?.("STALE (route) — re-rendering synchronously", options.cleanPathname);
      return null;
    }
  } catch (routeCacheError) {
    console.error("[vinext] ISR route cache read error:", routeCacheError);
  }

  return null;
}
