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
  const tag = slug;
  const path = `/cached/${slug}`;

  const renderedAt = new Date().toISOString();
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
      <div className="timestamp" data-testid="rendered-at">
        {renderedAt}
      </div>
      <p>
        Sample noise (re-rendered = re-randomised): <code>{random}</code>
      </p>

      <CacheStatusProbe path={path} />
      <RevalidateControls tag={tag} path={path} />
    </main>
  );
}
