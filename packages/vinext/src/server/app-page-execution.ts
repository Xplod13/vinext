export type AppPageSpecialError =
  | { kind: "redirect"; location: string; statusCode: number }
  | { kind: "http-access-fallback"; statusCode: number };

export type AppPageFontPreload = {
  href: string;
  type: string;
};

export type AppPageRscStreamCapture = {
  capturedRscDataPromise: Promise<ArrayBuffer> | null;
  responseStream: ReadableStream<Uint8Array>;
};

export type BuildAppPageSpecialErrorResponseOptions = {
  clearRequestContext: () => void;
  renderFallbackPage?: (statusCode: number) => Promise<Response | null>;
  requestUrl: string;
  specialError: AppPageSpecialError;
};

export type ProbeAppPageLayoutsOptions = {
  layoutCount: number;
  onLayoutError: (error: unknown, layoutIndex: number) => Promise<Response | null>;
  probeLayoutAt: (layoutIndex: number) => unknown;
  runWithSuppressedHookWarning<T>(probe: () => Promise<T>): Promise<T>;
};

export type ProbeAppPageComponentOptions = {
  awaitAsyncResult: boolean;
  onError: (error: unknown) => Promise<Response | null>;
  probePage: () => unknown;
  runWithSuppressedHookWarning<T>(probe: () => Promise<T>): Promise<T>;
};

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return Boolean(
    value &&
    (typeof value === "object" || typeof value === "function") &&
    "then" in value &&
    typeof value.then === "function",
  );
}

function getAppPageStatusText(statusCode: number): string {
  return statusCode === 403 ? "Forbidden" : statusCode === 401 ? "Unauthorized" : "Not Found";
}

/**
 * Build the default HTML fallback for HTTP access errors (404/403/401) when
 * no custom not-found.tsx / forbidden.tsx / unauthorized.tsx is present.
 *
 * Matches the Next.js default 404 page text so upstream tests can assert on
 * "This page could not be found".
 */
export function buildDefaultNotFoundHtml(statusCode: number): string {
  const titles: Record<number, string> = {
    404: "404: This page could not be found.",
    403: "403: Forbidden",
    401: "401: Unauthorized",
  };
  const bodies: Record<number, string> = {
    404: "This page could not be found.",
    403: "Forbidden",
    401: "Unauthorized",
  };
  const title = titles[statusCode] ?? "Error";
  const heading = String(statusCode);
  const bodyText = bodies[statusCode] ?? "An error occurred";
  const outerStyle =
    "font-family:-apple-system,BlinkMacSystemFont,Roboto," +
    '"Segoe UI",sans-serif;height:100vh;text-align:center;' +
    "display:flex;flex-direction:column;align-items:center;justify-content:center";
  const h1Style =
    "display:inline-block;border-right:1px solid rgba(0,0,0,.3);" +
    "margin:0;margin-right:20px;padding:10px 23px 10px 0;" +
    "font-size:24px;font-weight:500;vertical-align:top";
  const innerStyle =
    "display:inline-block;text-align:left;line-height:49px;" + "height:49px;vertical-align:middle";
  const h2Style = "font-size:14px;font-weight:normal;line-height:inherit;margin:0;padding:0";
  return (
    '<!DOCTYPE html><html><head><meta charSet="utf-8"/>' +
    '<meta name="robots" content="noindex"/>' +
    "<title>" +
    title +
    "</title></head>" +
    "<body>" +
    '<div style="' +
    outerStyle +
    '">' +
    "<div><style>body{margin:0}</style>" +
    '<h1 style="' +
    h1Style +
    '">' +
    heading +
    "</h1>" +
    '<div style="' +
    innerStyle +
    '">' +
    '<h2 style="' +
    h2Style +
    '">' +
    bodyText +
    "</h2>" +
    "</div></div></div></body></html>"
  );
}

export function resolveAppPageSpecialError(error: unknown): AppPageSpecialError | null {
  if (!(error && typeof error === "object" && "digest" in error)) {
    return null;
  }

  const digest = String(error.digest);

  if (digest.startsWith("NEXT_REDIRECT;")) {
    const parts = digest.split(";");
    return {
      kind: "redirect",
      location: decodeURIComponent(parts[2]),
      statusCode: parts[3] ? parseInt(parts[3], 10) : 307,
    };
  }

  if (digest === "NEXT_NOT_FOUND" || digest.startsWith("NEXT_HTTP_ERROR_FALLBACK;")) {
    return {
      kind: "http-access-fallback",
      statusCode: digest === "NEXT_NOT_FOUND" ? 404 : parseInt(digest.split(";")[1], 10),
    };
  }

  return null;
}

export async function buildAppPageSpecialErrorResponse(
  options: BuildAppPageSpecialErrorResponseOptions,
): Promise<Response> {
  if (options.specialError.kind === "redirect") {
    options.clearRequestContext();
    return Response.redirect(
      new URL(options.specialError.location, options.requestUrl),
      options.specialError.statusCode,
    );
  }

  if (options.renderFallbackPage) {
    const fallbackResponse = await options.renderFallbackPage(options.specialError.statusCode);
    if (fallbackResponse) {
      return fallbackResponse;
    }
  }

  options.clearRequestContext();
  const statusCode = options.specialError.statusCode;
  return new Response(buildDefaultNotFoundHtml(statusCode), {
    status: statusCode,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

export async function probeAppPageLayouts(
  options: ProbeAppPageLayoutsOptions,
): Promise<Response | null> {
  return options.runWithSuppressedHookWarning(async () => {
    for (let layoutIndex = options.layoutCount - 1; layoutIndex >= 0; layoutIndex--) {
      try {
        const layoutResult = options.probeLayoutAt(layoutIndex);
        if (isPromiseLike(layoutResult)) {
          await layoutResult;
        }
      } catch (error) {
        const response = await options.onLayoutError(error, layoutIndex);
        if (response) {
          return response;
        }
      }
    }

    return null;
  });
}

export async function probeAppPageComponent(
  options: ProbeAppPageComponentOptions,
): Promise<Response | null> {
  return options.runWithSuppressedHookWarning(async () => {
    try {
      const pageResult = options.probePage();
      if (isPromiseLike(pageResult)) {
        if (options.awaitAsyncResult) {
          await pageResult;
        } else {
          void Promise.resolve(pageResult).catch(() => {});
        }
      }
    } catch (error) {
      return options.onError(error);
    }

    return null;
  });
}

export async function readAppPageTextStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];

  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    chunks.push(decoder.decode(value, { stream: true }));
  }

  chunks.push(decoder.decode());
  return chunks.join("");
}

export async function readAppPageBinaryStream(
  stream: ReadableStream<Uint8Array>,
): Promise<ArrayBuffer> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalLength = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    chunks.push(value);
    totalLength += value.byteLength;
  }

  const buffer = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return buffer.buffer;
}

export function teeAppPageRscStreamForCapture(
  stream: ReadableStream<Uint8Array>,
  shouldCapture: boolean,
): AppPageRscStreamCapture {
  if (!shouldCapture) {
    return {
      capturedRscDataPromise: null,
      responseStream: stream,
    };
  }

  const [responseStream, captureStream] = stream.tee();
  return {
    capturedRscDataPromise: readAppPageBinaryStream(captureStream),
    responseStream,
  };
}

export function buildAppPageFontLinkHeader(
  preloads: readonly AppPageFontPreload[] | null | undefined,
): string {
  if (!preloads || preloads.length === 0) {
    return "";
  }

  return preloads
    .map((preload) => `<${preload.href}>; rel=preload; as=font; type=${preload.type}; crossorigin`)
    .join(", ");
}
