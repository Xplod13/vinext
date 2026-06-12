import { describe, expect, it } from "vite-plus/test";
import { applyAppMiddleware } from "../packages/vinext/src/server/app-middleware.js";

describe("hybrid App Router middleware context", () => {
  it("does not trust client-supplied context to skip middleware", async () => {
    let invocationCount = 0;
    const result = await applyAppMiddleware({
      cleanPathname: "/admin",
      context: { headers: null, requestHeaders: null, status: null },
      isProxy: false,
      middlewareContextSecret: "trusted-secret",
      module: {
        default: () => {
          invocationCount++;
          return new Response(null, { headers: { "x-middleware-next": "1" } });
        },
      },
      request: new Request("http://localhost:3000/admin", {
        headers: { "x-vinext-mw-ctx": "{}" },
      }),
    });

    expect(result.kind).toBe("continue");
    expect(invocationCount).toBe(1);
  });

  it("does not trust client-supplied context rewrites", async () => {
    let invocationCount = 0;
    const result = await applyAppMiddleware({
      cleanPathname: "/admin",
      context: { headers: null, requestHeaders: null, status: null },
      isProxy: false,
      middlewareContextSecret: "trusted-secret",
      module: {
        default: () => {
          invocationCount++;
          return new Response(null, { headers: { "x-middleware-next": "1" } });
        },
      },
      request: new Request("http://localhost:3000/admin", {
        headers: {
          "x-vinext-mw-ctx": JSON.stringify({ r: "http://127.0.0.1:1/internal" }),
        },
      }),
    });

    expect(result.kind).toBe("continue");
    expect(invocationCount).toBe(1);
  });

  it("accepts authenticated context without running middleware twice", async () => {
    const context = { headers: null as Headers | null, requestHeaders: null, status: null };
    let invocationCount = 0;
    const result = await applyAppMiddleware({
      cleanPathname: "/about",
      context,
      isProxy: false,
      middlewareContextSecret: "trusted-secret",
      module: {
        default: () => {
          invocationCount++;
          return new Response(null, { headers: { "x-middleware-next": "1" } });
        },
      },
      request: new Request("http://localhost:3000/about", {
        headers: {
          "x-vinext-mw-ctx": JSON.stringify({
            h: [["x-mw-ran", "true"]],
            r: null,
            s: null,
            t: "trusted-secret",
          }),
        },
      }),
    });

    expect(result.kind).toBe("continue");
    expect(invocationCount).toBe(0);
    expect(context.headers?.get("x-mw-ran")).toBe("true");
  });
});
