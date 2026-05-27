"use client";

import { useCallback, useEffect, useState } from "react";

type ProbeState = {
  status: number;
  cfCacheStatus: string | null;
  age: string | null;
  cacheControl: string | null;
  cacheTag: string | null;
  cfRay: string | null;
  fetchedAt: string;
};

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
 * Decide whether the worker actually rendered this response, based on the
 * outer cache verdict. Workers Cache `HIT` / `REVALIDATED` mean the response
 * came straight from the edge without invoking the Worker; `STALE` /
 * `UPDATING` are also served from cache (the Worker may run async to
 * refresh, but the bytes the client saw came from cache). Anything else —
 * `MISS`, `EXPIRED`, `BYPASS`, `DYNAMIC`, or no header at all (local dev,
 * non-Cloudflare runtime) — means the Worker ran for this request.
 */
function deriveSsr(cfCacheStatus: string | null): {
  ran: boolean;
  detail: string;
} {
  if (!cfCacheStatus) {
    return {
      ran: true,
      detail: "no cf-cache-status — running locally or no edge cache in front",
    };
  }
  const upper = cfCacheStatus.toUpperCase();
  switch (upper) {
    case "HIT":
      return { ran: false, detail: "served by Workers Cache without invoking the Worker" };
    case "REVALIDATED":
      return {
        ran: false,
        detail: "conditional check returned 304 — cached body re-used, Worker not invoked",
      };
    case "STALE":
    case "UPDATING":
      return {
        ran: false,
        detail:
          "stale cache served; Worker may have run async to refresh, but this response did not render",
      };
    case "MISS":
      return { ran: true, detail: "Worker ran and produced this response" };
    case "EXPIRED":
      return { ran: true, detail: "previous cache entry expired — Worker ran to regenerate" };
    case "BYPASS":
      return { ran: true, detail: "cache bypassed (e.g. Set-Cookie / Authorization) — Worker ran" };
    case "DYNAMIC":
      return { ran: true, detail: "non-cacheable response — Worker ran" };
    default:
      return { ran: true, detail: `cf-cache-status: ${cfCacheStatus} — Worker ran` };
  }
}

export function CacheStatusProbe({ path }: { path: string }) {
  const [state, setState] = useState<ProbeState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const probe = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(path, {
        method: "GET",
        // Skip the browser HTTP cache so the response we see is the one the
        // outer Workers Cache (or origin) actually returned.
        cache: "no-store",
        headers: { "x-probe": "1" },
      });
      setState({
        status: res.status,
        cfCacheStatus: res.headers.get("cf-cache-status"),
        age: res.headers.get("age"),
        cacheControl: res.headers.get("cache-control"),
        cacheTag: res.headers.get("cache-tag"),
        cfRay: res.headers.get("cf-ray"),
        fetchedAt: new Date().toLocaleTimeString(),
      });
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
  const ssr = state ? deriveSsr(cfStatus) : null;

  return (
    <section className="panel" aria-label="Cache status probe">
      <h2 style={{ marginTop: 0 }}>
        Probe <code>{path}</code>
      </h2>
      <p style={{ marginTop: 0, color: "var(--muted)" }}>
        Issues a no-store <code>fetch</code> against the route and surfaces the headers Cloudflare
        attaches at the edge. <code>cf-cache-status</code> is the outer Workers Cache verdict —
        <code>HIT</code> means the response came from cache without invoking the worker;{" "}
        <code>MISS</code> / <code>EXPIRED</code> means the worker ran.
      </p>

      {ssr ? <SsrBadge ran={ssr.ran} detail={ssr.detail} /> : null}

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

function SsrBadge({ ran, detail }: { ran: boolean; detail: string }) {
  return (
    <div className={`ssr-banner ${ran ? "ssr-banner-ran" : "ssr-banner-cached"}`}>
      <strong>
        {ran ? "Worker ran for this response" : "Served from cache — Worker not invoked"}
      </strong>
      <span>{detail}</span>
    </div>
  );
}
