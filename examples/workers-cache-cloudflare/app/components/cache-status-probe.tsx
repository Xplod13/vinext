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

  return (
    <section className="panel" aria-label="Cache status probe">
      <h2 style={{ marginTop: 0 }}>
        Probe <code>{path}</code>
      </h2>
      <p style={{ marginTop: 0, color: "var(--muted)" }}>
        Issues a no-store <code>fetch</code> against the route and surfaces the headers Cloudflare
        attaches at the edge. <code>cf-cache-status</code> is the outer Workers Cache verdict —
        <code>HIT</code> means the response came from cache without invoking the worker;{" "}
        <code>MISS</code> / <code>EXPIRED</code> means the worker ran. <code>Age</code> is how
        many seconds the cached copy has been sitting at the edge.
      </p>

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
