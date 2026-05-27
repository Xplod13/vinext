// Cached App Route handler. vinext emits ISR Cache-Control headers and a
// Cache-Tag for the path so the Workers Cache layer caches the response
// for 30 seconds and tag-based revalidation works.
export const revalidate = 30;

export async function GET(): Promise<Response> {
  return Response.json({
    now: new Date().toISOString(),
    random: Math.random(),
    note: "Cached by vinext + Workers Cache for 30 seconds.",
  });
}
