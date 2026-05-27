import { CacheStatusProbe } from "../../components/cache-status-probe";
import { RevalidateControls } from "../../components/revalidate-controls";

// ISR config — slugs are cached for 60 seconds with a 5-minute
// stale-while-revalidate window. vinext emits this as
// `Cache-Control: s-maxage=60, stale-while-revalidate=240` and the Workers
// Cache layer honours it automatically.
export const revalidate = 60;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  return { title: `Cached page: ${slug}` };
}

export default async function CachedSlugPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const path = `/cached/${slug}`;
  // Use the implicit `_N_T_<path>` page tag vinext writes onto every
  // App Router cache entry. The slug on its own (`intro`) is not attached
  // to anything, so revalidateTag("intro") would silently no-op.
  const tag = `_N_T_${path}`;

  // Generated at render time. Embedded into the response so the client probe
  // can tell whether a subsequent fetch was actually re-rendered (new id) or
  // served from cache (same id). This is the only honest source of truth for
  // "did SSR happen for that response" — outer cache headers describe what
  // the cache layer thinks, not what the React tree actually did.
  const renderedAt = new Date().toISOString();
  const renderId = crypto.randomUUID();
  const random = Math.random().toFixed(6);

  return (
    <main>
      <nav className="crumbs">
        <a href="/">&larr; Demo home</a>
      </nav>
      <h1>
        <code>/cached/{slug}</code>
      </h1>
      <p className="tagline">
        ISR-cached for <code>revalidate = 60</code>. The first request renders on the server;
        subsequent reads are served by whatever HTTP cache sits in front of the runtime — for
        example, the platform-managed cache exposed via <code>ctx.cache</code> on Cloudflare
        Workers when <code>cache.enabled: true</code>.
      </p>

      <p>Server-side timestamp:</p>
      <div
        className="timestamp"
        data-testid="rendered-at"
        data-render-id={renderId}
        data-render-time={renderedAt}
      >
        {renderedAt}
      </div>
      <p>
        Render ID: <code data-render-id-tag>{renderId}</code>
      </p>
      <p>
        Sample noise (re-rendered = re-randomised): <code>{random}</code>
      </p>

      <CacheStatusProbe path={path} initialRenderId={renderId} initialRenderTime={renderedAt} />
      <RevalidateControls tag={tag} path={path} />
    </main>
  );
}
