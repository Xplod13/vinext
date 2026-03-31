/**
 * next-test-utils shim
 *
 * Provides the subset of `next-test-utils` exports that the upstream Next.js
 * e2e test suite uses, backed by plain Node.js / fetch — no dependency on the
 * real `next-test-utils` package.
 *
 * Aliased as `next-test-utils` in the Vitest integration project config so
 * ported test files can keep their original imports unchanged:
 *
 *   import { check, retry, waitFor } from 'next-test-utils'
 *
 * ── Implemented exports ───────────────────────────────────────────────────────
 *
 *   check(fn, expected)          Poll fn() until it matches expected (string or
 *                                RegExp). Throws after 30 s if never matches.
 *
 *   retry(fn, opts?)             Re-run an async assertion fn until it stops
 *                                throwing. Useful with expect() inside the fn.
 *
 *   waitFor(ms)                  Simple Promise-based sleep.
 *
 *   renderViaHTTP(origin, path)  Fetch a page and return its HTML text.
 *
 *   fetchViaHTTP(origin, path,   Low-level fetch with optional query params and
 *                query, init)    init — mirrors Next.js test utils signature.
 *
 *   getTitle($)                  Extract <title> text from a cheerio-like $.
 *
 *   expectVaryHeaderToContain    Assert that a Response's Vary header includes
 *     (res, value)               a specific token.
 *
 *   normalizeRegEx(re)           Strip the surrounding / delimiters from a
 *                                RegExp.toString() result.
 *
 *   File                         Re-export of the Node.js `fs/promises` File
 *                                equivalent — exposed as a named export so test
 *                                files that do `const { File } = require(...)` work.
 *                                (In Node 20+ global File exists; this just
 *                                re-exports it for explicitness.)
 *
 * ── Stub exports (no-op / always-pass) ───────────────────────────────────────
 *
 *   The following are referenced in some test files but are either irrelevant
 *   in the vinext context (no real Next.js server process to manage) or are
 *   only called in branches that are gated behind flags we never set (e.g.
 *   isNextStart, isNextDeploy). They are provided as stubs so import
 *   resolution succeeds without runtime errors in the tests we do run.
 *
 *   launchApp, killApp, nextBuild, nextStart, nextTest, runNextCommand,
 *   findPort, startCleanStaticServer, shouldUseTurbopack,
 *   findAllTelemetryEvents, getDistDir, getClientReferenceManifest,
 *   assertNoConsoleErrors, getRedboxHeader, getRedboxDescription,
 *   getRedboxSource, getUrlFromBackgroundImage, colorToRgb,
 *   createMultiDomMatcher, getCacheHeader
 */

// ─── check ───────────────────────────────────────────────────────────────────

const CHECK_POLL_INTERVAL_MS = 100;
const CHECK_TIMEOUT_MS = 30_000;

/**
 * Repeatedly call `fn` until the returned value satisfies `expected`.
 *
 * `expected` can be:
 *   - a string  → strict equality
 *   - a RegExp  → RegExp.test()
 *   - a function → called with the result, truthy return means pass
 *
 * Throws if the condition is not met within `timeoutMs` (default 30 s).
 */
export async function check(
  fn: () => unknown | Promise<unknown>,
  expected: string | RegExp | ((val: unknown) => boolean),
  timeoutMs = CHECK_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastValue: unknown;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      lastValue = await fn();
      const pass =
        typeof expected === "function"
          ? expected(lastValue)
          : expected instanceof RegExp
            ? expected.test(String(lastValue))
            : lastValue === expected;

      if (pass) return;
    } catch (e) {
      lastError = e;
    }
    await waitFor(CHECK_POLL_INTERVAL_MS);
  }

  if (lastError) throw lastError;

  throw new Error(
    `check() timed out after ${timeoutMs} ms.\n` +
      `  Expected: ${String(expected)}\n` +
      `  Last value: ${JSON.stringify(lastValue)}`,
  );
}

// ─── retry ────────────────────────────────────────────────────────────────────

/**
 * Re-run `fn` until it resolves without throwing.
 *
 * Useful for wrapping expect() assertions that may need to wait for async
 * state to settle, e.g.:
 *
 *   await retry(() => expect(browser.elementById('count').text()).resolves.toBe('3'))
 *
 * Options:
 *   retries      Maximum number of attempts (default 30)
 *   intervalMs   Delay between attempts in ms (default 100)
 */
export async function retry<T>(
  fn: () => T | Promise<T>,
  opts: { retries?: number; intervalMs?: number } = {},
): Promise<T> {
  const { retries = 30, intervalMs = 100 } = opts;
  let lastError: unknown;

  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      await waitFor(intervalMs);
    }
  }

  throw lastError;
}

// ─── waitFor ──────────────────────────────────────────────────────────────────

/**
 * Resolve after `ms` milliseconds. Drop-in for the Next.js test-utils `waitFor`
 * which is a simple sleep (not the React Testing Library variant).
 */
export function waitFor(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── renderViaHTTP ────────────────────────────────────────────────────────────

/**
 * Fetch `path` from `appPort` (a port number or full origin string) and return
 * the response body as text.
 *
 *   const html = await renderViaHTTP(next.url, '/about')
 */
export async function renderViaHTTP(
  appPort: number | string,
  path: string,
  query?: Record<string, string> | string,
  opts?: RequestInit,
): Promise<string> {
  const res = await fetchViaHTTP(appPort, path, query, opts);
  return res.text();
}

// ─── fetchViaHTTP ─────────────────────────────────────────────────────────────

/**
 * Fetch `path` from `appPort` (a port number or full origin string).
 *
 * `query` may be a plain object or a pre-encoded query string.
 * Extra fetch options may be passed via `opts`.
 */
export async function fetchViaHTTP(
  appPort: number | string,
  path: string,
  query?: Record<string, string> | string | null,
  opts?: RequestInit,
): Promise<Response> {
  const origin = typeof appPort === "number" ? `http://localhost:${appPort}` : appPort;

  let qs = "";
  if (query != null) {
    if (typeof query === "string") {
      qs = query.startsWith("?") ? query : `?${query}`;
    } else {
      const params = new URLSearchParams(query);
      qs = `?${params.toString()}`;
    }
  }

  const url = `${origin}${path}${qs}`;
  return fetch(url, opts);
}

// ─── getTitle ────────────────────────────────────────────────────────────────

/**
 * Extract the text content of the first <title> element from a cheerio-like
 * `$` object (or any object where `$('title').text()` works).
 */
export function getTitle($: (selector: string) => { text(): string }): string {
  return $("title").text();
}

// ─── expectVaryHeaderToContain ───────────────────────────────────────────────

/**
 * Assert that the `Vary` header in `res` contains `token` (case-insensitive).
 *
 *   expectVaryHeaderToContain(res, 'RSC')
 */
export function expectVaryHeaderToContain(
  varyOrRes: Response | string | null,
  tokenOrTokens: string | string[],
): void {
  const vary =
    varyOrRes === null
      ? ""
      : typeof varyOrRes === "string"
        ? varyOrRes
        : (varyOrRes.headers.get("vary") ?? "");
  const actual = vary.split(",").map((t) => t.trim().toLowerCase());
  const expected = Array.isArray(tokenOrTokens) ? tokenOrTokens : [tokenOrTokens];
  for (const token of expected) {
    if (!actual.includes(token.toLowerCase())) {
      throw new Error(`Expected Vary header to contain "${token}" but got: "${vary}"`);
    }
  }
}

// ─── normalizeRegEx ───────────────────────────────────────────────────────────

/**
 * Convert a RegExp (or string) to the plain string form used in Next.js route
 * manifests — strips the surrounding `/` delimiters and any flags.
 *
 *   normalizeRegEx(/^\/blog\/(.+)$/)  →  '^\/blog\/(.+)$'
 */
export function normalizeRegEx(re: RegExp | string): string {
  if (typeof re === "string") return re;
  // RegExp.toString() → '/pattern/flags'
  return re.toString().slice(1, re.toString().lastIndexOf("/"));
}

// ─── File ─────────────────────────────────────────────────────────────────────

// Node 20+ has a global File. Declare it as a const so test files that import
// File from this module get the real thing without a direct re-export error.
// eslint-disable-next-line no-undef
export const File = globalThis.File;

// ─── Stubs ───────────────────────────────────────────────────────────────────
//
// These are referenced in test files but are irrelevant in the vinext context.
// Provided as no-ops / always-resolve stubs so import resolution succeeds.

// oxlint-disable-next-line typescript/no-explicit-any
type AnyFn = (...args: any[]) => any;

function stub(name: string): AnyFn {
  return (..._args: unknown[]) => {
    console.warn(
      `[next-test-utils shim] "${name}" is not implemented — ` +
        `this call is a no-op in the vinext test environment.`,
    );
    return Promise.resolve(undefined);
  };
}

export const launchApp = stub("launchApp");
export const killApp = stub("killApp");
export const nextBuild = stub("nextBuild");
export const nextStart = stub("nextStart");
export const nextTest = stub("nextTest");
export const runNextCommand = stub("runNextCommand");
export const findPort = stub("findPort");
export const startCleanStaticServer = stub("startCleanStaticServer");
export const findAllTelemetryEvents = stub("findAllTelemetryEvents");
export const getDistDir = stub("getDistDir");
export const getClientReferenceManifest = stub("getClientReferenceManifest");
export const assertNoConsoleErrors = stub("assertNoConsoleErrors");
export const getRedboxHeader = stub("getRedboxHeader");
export const getRedboxDescription = stub("getRedboxDescription");
export const getRedboxSource = stub("getRedboxSource");
export const getUrlFromBackgroundImage = stub("getUrlFromBackgroundImage");
export const getCacheHeader = stub("getCacheHeader");

/** Always returns false — we never run under Turbopack. */
export function shouldUseTurbopack(): boolean {
  return false;
}

/**
 * Convert a CSS colour name or hex string to an `rgb(r, g, b)` string.
 * Only implements the small subset used in Next.js tests.
 */
export function colorToRgb(color: string): string {
  const named: Record<string, string> = {
    red: "rgb(255, 0, 0)",
    green: "rgb(0, 128, 0)",
    blue: "rgb(0, 0, 255)",
    white: "rgb(255, 255, 255)",
    black: "rgb(0, 0, 0)",
    yellow: "rgb(255, 255, 0)",
  };
  const lower = color.toLowerCase();
  if (lower in named) return named[lower];

  // Hex → rgb
  const hex = lower.replace(/^#/, "");
  if (hex.length === 3) {
    const [r, g, b] = hex.split("").map((c) => parseInt(c + c, 16));
    return `rgb(${r}, ${g}, ${b})`;
  }
  if (hex.length === 6) {
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    return `rgb(${r}, ${g}, ${b})`;
  }
  return color;
}

/**
 * Returns a function that checks whether a given DOM element (from a
 * cheerio-like $) matches all of the provided matchers simultaneously.
 * The upstream usage is typically:
 *
 *   const matchesAll = createMultiDomMatcher($)
 *   expect(matchesAll('#id', { content: 'foo', href: '/bar' })).toBe(true)
 */
export function createMultiDomMatcher(
  $: (selector: string) => { attr(name: string): string | undefined; text(): string },
) {
  return function matchesAll(selector: string, matchers: Record<string, string>): boolean {
    const el = $(selector);
    return Object.entries(matchers).every(([key, value]) => {
      if (key === "content") return el.text().includes(value);
      return el.attr(key) === value;
    });
  };
}

export const waitForNoErrorToast = stub("waitForNoErrorToast");
