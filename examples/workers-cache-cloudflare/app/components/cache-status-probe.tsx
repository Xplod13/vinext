"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type ProbeState = {
  status: number;
  cfCacheStatus: string | null;
  age: string | null;
  cacheControl: string | null;
  cacheTag: string | null;
  cfRay: string | null;
  fetchedAt: string;
  /** UUID embedded in the response body at SSR time, when present. */
  renderId: string | null;
  /** ISO timestamp the response was rendered at, when present. */
  renderTime: string | null;
};

type SsrVerdict =
  | { kind: "fresh"; detail: string }
  | { kind: "cached"; detail: string }
  | { kind: "unknown"; detail: string };

/**
 * Map a `cf-cache-status` value to one of our badge classes. Mirrors the
 * states documented at
 * https://developers.cloudflare.com/cache/concepts/default-cache-behavior/#cloudflare-cache-responses
 */
function badgeClassFor(status: string | null): string {
  if (!status) return "";
  switch (status.toUpperCase()) {
    case "HIT":
    case "REVALIDATED":
      return "badge-hit";
    case "STALE":
    case "UPDATING":
      return "badge-stale";
    case "MISS":
    case "EXPIRED":
      return "badge-miss";
    default:
      return "";
  }
}

/**
 * Pull the render-id and render-time the server embedded into the response.
 * HTML pages put them on `[data-testid="rendered-at"]`'s data attributes;
 * JSON route handlers include them as top-level fields.
 */
async function extractRenderMarkers(
  res: Response,
): Promise<{ renderId: string | null; renderTime: string | null }> {
  const contentType = res.headers.get("content-type") ?? "";
  try {
    if (contentType.includes("application/json")) {
      const body = (await res.clone().json()) as Record<string, unknown>;
      const renderId = typeof body.renderId === "string" ? body.renderId : null;
      const renderTime = typeof body.now === "string" ? body.now : null;
      return { renderId, renderTime };
    }
    if (contentType.includes("text/html")) {
      const html = await res.clone().text();
      const idMatch = html.match(/data-render-id="([^"]+)"/);
      const timeMatch = html.match(/data-render-time="([^"]+)"/);
      return {
        renderId: idMatch ? idMatch[1] : null,
        renderTime: timeMatch ? timeMatch[1] : null,
      };
    }
  } catch {
    // Ignore parse errors — the markers are best-effort.
  }
  return { renderId: null, renderTime: null };
}

/**
 * Decide whether SSR actually produced the response we just received, by
 * comparing the response's render-id against the previously-seen one.
 *
 * - Different (or first-ever) render-id → SSR happened on the server.
 * - Same render-id → the same bytes came back, which means a cache (outer
 *   Workers Cache, inner ISR, or proxy in between) served the response
 *   without re-rendering.
 * - No render-id in the response → we can't tell from the body alone, so
 *   we surface "unknown" rather than make something up.
 */
function deriveSsr(
  currentRenderId: string | null,
  previousRenderId: string | null,
): SsrVerdict {
  if (currentRenderId === null) {
    return {
      kind: "unknown",
      detail:
        "no render-id embedded in this response — can't tell from the body whether SSR ran",
    };
  }
  if (previousRenderId === null) {
    return {
      kind: "fresh",
      detail: `render-id ${shorten(currentRenderId)} captured — re-probe to compare`,
    };
  }
  if (currentRenderId === previousRenderId) {
    return {
      kind: "cached",
      detail: `render-id matches the previous probe (${shorten(currentRenderId)}) — same bytes, no re-render`,
    };
  }
  return {
    kind: "fresh",
    detail: `render-id changed (${shorten(previousRenderId)} → ${shorten(currentRenderId)}) — SSR produced a new response`,
  };
}

function shorten(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…` : id;
}

export function CacheStatusProbe({
  path,
  initialRenderId = null,
  initialRenderTime = null,
}: {
  path: string;
  initialRenderId?: string | null;
  initialRenderTime?: string | null;
}) {
  const [state, setState] = useState<ProbeState | null>(null);
  const [verdict, setVerdict] = useState<SsrVerdict | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The render-id from the previous probe (or the initial server render).
  // Compared against the next probe's render-id to detect cache vs SSR.
  const previousRenderIdRef = useRef<string | null>(initialRenderId);

  const probe = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      // Mirror what a browser navigation would send so the probe lands in
      // the same Vary bucket as the original page load. Our responses set
      // `Vary: Accept, ...`, which means Workers Cache keys separate entries
      // per Accept value — `fetch()`'s default `Accept: */*` would hit a
      // *different* cached entry than the one the user navigated into.
      //
      // We intentionally do NOT pass `cache: 'no-store'`: that adds
      // `Cache-Control: no-cache` to the request, which Workers Cache
      // honours by bypassing and re-running the origin. The whole point of
      // this probe is to observe what the outer cache actually serves.
      const acceptForHtml =
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8";
      const res = await fetch(path, {
        method: "GET",
        headers: { Accept: acceptForHtml },
      });
      const markers = await extractRenderMarkers(res);
      setState({
        status: res.status,
        cfCacheStatus: res.headers.get("cf-cache-status"),
        age: res.headers.get("age"),
        cacheControl: res.headers.get("cache-control"),
        cacheTag: res.headers.get("cache-tag"),
        cfRay: res.headers.get("cf-ray"),
        fetchedAt: new Date().toLocaleTimeString(),
        renderId: markers.renderId,
        renderTime: markers.renderTime,
      });
      setVerdict(deriveSsr(markers.renderId, previousRenderIdRef.current));
      // Update for the next round. If this response had no render-id, keep
      // the previous one so a future probe can still compare.
      if (markers.renderId !== null) {
        previousRenderIdRef.current = markers.renderId;
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [path]);

  useEffect(() => {
    void probe();
  }, [probe]);

  const cfStatus = state?.cfCacheStatus ?? null;

  return (
    <section className="panel" aria-label="Cache status probe">
      <h2 style={{ marginTop: 0 }}>
        Probe <code>{path}</code>
      </h2>
      <p style={{ marginTop: 0, color: "var(--muted)" }}>
        Issues a no-store <code>fetch</code> against the route. The route embeds a fresh{" "}
        <code>render-id</code> into every server-rendered response — comparing it across probes is
        the most reliable way to tell whether SSR actually happened or a cache served the same
        bytes again. <code>cf-cache-status</code> is shown alongside as the outer Workers Cache
        verdict.
      </p>

      {verdict ? <SsrBadge verdict={verdict} /> : null}

      <div className="controls">
        <button type="button" onClick={() => void probe()} disabled={busy}>
          {busy ? "Probing…" : "Re-probe"}
        </button>
        <a href={path} className="button">
          Open in new tab
        </a>
      </div>

      <dl className="kv">
        <dt>HTTP status</dt>
        <dd>{state?.status ?? "—"}</dd>
        <dt>render-id</dt>
        <dd>{state?.renderId ?? "—"}</dd>
        <dt>render-time</dt>
        <dd>{state?.renderTime ?? initialRenderTime ?? "—"}</dd>
        <dt>cf-cache-status</dt>
        <dd>
          {cfStatus ? (
            <span className={`badge ${badgeClassFor(cfStatus)}`}>{cfStatus}</span>
          ) : (
            <span style={{ color: "var(--muted)" }}>
              not set — running locally, or the runtime doesn't expose it
            </span>
          )}
        </dd>
        <dt>Age</dt>
        <dd>{state?.age ?? "—"}</dd>
        <dt>Cache-Control</dt>
        <dd>{state?.cacheControl ?? "—"}</dd>
        <dt>Cache-Tag</dt>
        <dd>{state?.cacheTag ?? "—"}</dd>
        <dt>cf-ray</dt>
        <dd>{state?.cfRay ?? "—"}</dd>
        <dt>Probed at</dt>
        <dd>{state?.fetchedAt ?? "—"}</dd>
      </dl>
      {error ? <p style={{ color: "var(--bad)" }}>{error}</p> : null}
    </section>
  );
}

function SsrBadge({ verdict }: { verdict: SsrVerdict }) {
  const cls =
    verdict.kind === "fresh"
      ? "ssr-banner-ran"
      : verdict.kind === "cached"
        ? "ssr-banner-cached"
        : "ssr-banner-unknown";
  const title =
    verdict.kind === "fresh"
      ? "SSR ran — response was freshly rendered"
      : verdict.kind === "cached"
        ? "No SSR — same render-id as last probe (cache served this)"
        : "SSR status: unknown";
  return (
    <div className={`ssr-banner ${cls}`}>
      <strong>{title}</strong>
      <span>{verdict.detail}</span>
    </div>
  );
}
