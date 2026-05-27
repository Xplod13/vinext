"use client";

import { useCallback, useEffect, useState } from "react";

type ProbeState = {
  status: number;
  cacheState: string;
  cacheControl: string;
  cacheTag: string;
  age: string;
  fetchedAt: string;
};

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
        // Bypass the browser cache so we observe the actual edge response
        // — only the Workers Cache layer should be deciding.
        cache: "no-store",
        headers: { "x-probe": "1" },
      });
      setState({
        status: res.status,
        cacheState: res.headers.get("x-vinext-cache") ?? res.headers.get("x-nextjs-cache") ?? "—",
        cacheControl: res.headers.get("cache-control") ?? "—",
        cacheTag: res.headers.get("cache-tag") ?? "—",
        age: res.headers.get("age") ?? "—",
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

  const stateLabel = state?.cacheState ?? "—";
  const badgeClass =
    stateLabel === "HIT" || stateLabel === "STATIC"
      ? "badge-hit"
      : stateLabel === "STALE"
        ? "badge-stale"
        : stateLabel === "MISS"
          ? "badge-miss"
          : "";

  return (
    <section className="panel" aria-label="Cache status probe">
      <h2 style={{ marginTop: 0 }}>
        Probe <code>{path}</code>
      </h2>
      <p style={{ marginTop: 0, color: "var(--muted)" }}>
        Issues a no-store <code>fetch</code> against the cached route and reports the headers
        returned by the edge. Cache layer behaviour shows up under{" "}
        <code>x-vinext-cache</code> (vinext / inner cache) and HTTP <code>Age</code> (Workers
        Cache outer layer).
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
        <dt>Cache state</dt>
        <dd>
          <span className={`badge ${badgeClass}`}>{stateLabel}</span>
        </dd>
        <dt>Cache-Control</dt>
        <dd>{state?.cacheControl ?? "—"}</dd>
        <dt>Cache-Tag</dt>
        <dd>{state?.cacheTag ?? "—"}</dd>
        <dt>Age (outer)</dt>
        <dd>{state?.age ?? "—"}</dd>
        <dt>Probed at</dt>
        <dd>{state?.fetchedAt ?? "—"}</dd>
      </dl>
      {error ? <p style={{ color: "var(--bad)" }}>{error}</p> : null}
    </section>
  );
}
