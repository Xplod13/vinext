import type { Route } from "../routing/pages-router.js";
import { addQueryParam } from "../utils/query.js";
import {
  createPagesReqRes,
  parsePagesApiBody,
  type PagesRequestQuery,
  type PagesReqResRequest,
  type PagesReqResResponse,
  PagesApiBodyParseError,
} from "./pages-node-compat.js";

type PagesApiRouteModule = {
  default?:
    | ((req: PagesReqResRequest, res: PagesReqResResponse) => void | Promise<void>)
    | ((req: Request) => Response | Promise<Response>);
};

export type PagesApiRouteMatch = {
  params: PagesRequestQuery;
  route: Pick<Route, "pattern"> & {
    module: PagesApiRouteModule;
  };
};

export type HandlePagesApiRouteOptions = {
  match: PagesApiRouteMatch | null;
  reportRequestError?: (error: Error, routePattern: string) => void | Promise<void>;
  request: Request;
  url: string;
};

function buildPagesApiQuery(url: string, params: PagesRequestQuery): PagesRequestQuery {
  const query: PagesRequestQuery = { ...params };
  const search = url.split("?")[1];
  if (!search) {
    return query;
  }

  for (const [key, value] of new URLSearchParams(search)) {
    addQueryParam(query, key, value);
  }

  return query;
}

export async function handlePagesApiRoute(options: HandlePagesApiRouteOptions): Promise<Response> {
  if (!options.match) {
    return new Response("404 - API route not found", { status: 404 });
  }

  const { route, params } = options.match;
  const handler = route.module.default;
  if (typeof handler !== "function") {
    return new Response("API route does not export a default function", { status: 500 });
  }

  try {
    const query = buildPagesApiQuery(options.url, params);

    // Detect edge runtime handlers: they accept a Web API Request and return a
    // Response directly, rather than using the Node.js-style (req, res) API.
    // We identify them by checking the module's config export or by duck-typing
    // the return value — if the handler returns a Response instance, use it.
    const routeModule = route.module as PagesApiRouteModule & { config?: { runtime?: string } };
    const isEdgeRuntime = routeModule.config?.runtime === "edge";

    if (isEdgeRuntime) {
      const result = await (handler as (req: Request) => Response | Promise<Response>)(
        options.request,
      );
      if (result instanceof Response) {
        return result;
      }
      return new Response("Edge API route did not return a Response", { status: 500 });
    }

    const body = await parsePagesApiBody(options.request);
    const { req, res, responsePromise } = createPagesReqRes({
      body,
      query,
      request: options.request,
      url: options.url,
    });

    // Call the handler. For edge-style handlers that slipped past the config
    // check (e.g. no explicit config export), duck-type the return value: if
    // it's a Response, return it directly instead of waiting on responsePromise.
    const handlerResult = await (
      handler as (req: PagesReqResRequest, res: PagesReqResResponse) => unknown
    )(req as PagesReqResRequest, res as PagesReqResResponse);
    if (handlerResult instanceof Response) {
      return handlerResult;
    }
    res.end();
    return await responsePromise;
  } catch (error) {
    if (error instanceof PagesApiBodyParseError) {
      return new Response(error.message, {
        status: error.statusCode,
        statusText: error.message,
      });
    }

    void options.reportRequestError?.(
      error instanceof Error ? error : new Error(String(error)),
      route.pattern,
    );
    return new Response("Internal Server Error", { status: 500 });
  }
}
