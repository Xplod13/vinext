import { CacheStatusProbe } from "../components/cache-status-probe";

// Comparison page: force-dynamic. The Worker runs on every request. vinext
// emits `Cache-Control: private, no-cache, no-store, ...` so the outer
// Workers Cache layer must not cache the response.
export const dynamic = "force-dynamic";

export default function DynamicPage() {
  const renderedAt = new Date().toISOString();
  return (
    <main>
      <nav className="crumbs">
        <a href="/">&larr; Demo home</a>
      </nav>
      <h1>
        <code>/dynamic</code>
      </h1>
      <p className="tagline">
        Bypass case for comparison. <code>force-dynamic</code> means vinext emits{" "}
        <code>no-store</code> headers, so neither the outer <code>ctx.cache</code> nor the
        inner CacheHandler retains anything. The timestamp updates on every reload.
      </p>
      <div className="timestamp" data-testid="rendered-at">
        {renderedAt}
      </div>
      <CacheStatusProbe path="/dynamic" />
    </main>
  );
}
