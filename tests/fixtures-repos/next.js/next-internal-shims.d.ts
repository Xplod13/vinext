/**
 * Ambient type declarations for Next.js-internal test packages that are not
 * published to npm. These exist in the Next.js monorepo's private test
 * infrastructure and are used by the upstream e2e test suite.
 *
 * We declare them as `any`-typed stubs so TypeScript is satisfied when
 * compiling the cloned Next.js tests in this repo.
 */

// ─── next-webdriver ────────────────────────────────────────────────────────────
//
// The upstream Next.js test suite uses a Selenium/WebDriver-based browser
// automation wrapper. In this repo, the equivalent is our Playwright-backed
// BrowserInstance from next-test-setup.ts — we alias it at runtime via Vitest.
// Here we just need the types to compile.

declare module "next-webdriver" {
  export type WebdriverOptions = {
    waitHydration?: boolean;
    disableCache?: boolean;
    beforePageLoad?: (page: unknown) => void;
  };

  export type ElementHandle = {
    text(): Promise<string>;
    html(): Promise<string>;
    attr(name: string): Promise<string | null>;
    click(): Promise<ElementHandle>;
    type(text: string): Promise<ElementHandle>;
    getValue(): Promise<string>;
    elementById(id: string): Promise<ElementHandle>;
    waitForElementByCss(selector: string, timeoutMs?: number): Promise<ElementHandle>;
  };

  export type Playwright = {
    readonly page: unknown;
    elementByCss(selector: string): ElementHandle;
    elementById(id: string): ElementHandle;
    elementsByCss(selector: string): Promise<ElementHandle[]>;
    hasElementByCssSelector(selector: string): Promise<boolean>;
    waitForElementByCss(selector: string, timeoutMs?: number): Promise<ElementHandle>;
    waitForIdleNetwork(timeoutMs?: number): Promise<void>;
    eval(expression: string): Promise<unknown>;
    url(): Promise<string>;
    loadPage(url: string, opts?: { disableCache?: boolean }): Promise<void>;
    back(): Promise<void>;
    forward(): Promise<void>;
    refresh(): Promise<void>;
    close(): Promise<void>;
    log(): Promise<Array<{ source: string; message: string }>>;
    deleteCookies(): Promise<void>;
    addCookie(cookie: {
      name: string;
      value: string;
      domain?: string;
      path?: string;
      expires?: number;
      httpOnly?: boolean;
      secure?: boolean;
      sameSite?: "Strict" | "Lax" | "None";
    }): Promise<void>;
    on(event: string, handler: (...args: unknown[]) => void): void;
  };

  function webdriver(
    appPort: number | string,
    path: string,
    opts?: WebdriverOptions,
  ): Promise<Playwright>;

  export default webdriver;
}

// ─── router-act ───────────────────────────────────────────────────────────────
//
// Internal Next.js helper for wrapping router state updates in React `act()`.

declare module "router-act" {
  export function createRouterAct(
    opts?: Record<string, unknown>,
  ): (...args: unknown[]) => Promise<void>;
}

// ─── development-sandbox ──────────────────────────────────────────────────────
//
// Internal Next.js helper for spinning up isolated Next.js dev server instances
// inside tests.

declare module "development-sandbox" {
  export type Sandbox = {
    session: unknown;
    cleanup(): Promise<void>;
  };

  export function createSandbox(opts?: {
    nextConfig?: Record<string, unknown>;
    files?: Record<string, string>;
    [key: string]: unknown;
  }): Promise<Sandbox>;
}

// ─── test-data-service/writer ─────────────────────────────────────────────────
//
// Internal Next.js helper for coordinating data between a test server and test
// assertions.

declare module "test-data-service/writer" {
  export type TestDataServer = {
    port: number;
    url: string;
    stop(): Promise<void>;
    write(key: string, value: unknown): Promise<void>;
    read(key: string): Promise<unknown>;
    waitFor(key: string, expected: unknown, timeoutMs?: number): Promise<void>;
  };

  export function createTestDataServer(opts?: {
    port?: number;
    [key: string]: unknown;
  }): Promise<TestDataServer>;
}

// ─── test-log ─────────────────────────────────────────────────────────────────
//
// Internal Next.js helper for capturing and asserting on log output from
// test processes.

declare module "test-log" {
  export type TestLog = {
    lines: string[];
    clear(): void;
    wait(pattern: string | RegExp, timeoutMs?: number): Promise<string>;
  };

  export function createTestLog(opts?: { port?: number; [key: string]: unknown }): Promise<TestLog>;
}

// ─── e2e-utils/request-tracker ────────────────────────────────────────────────
//
// Internal Next.js helper for tracking HTTP requests made during a test.

declare module "e2e-utils/request-tracker" {
  export type RequestTracker = {
    requests: Array<{ url: string; method: string; headers: Record<string, string> }>;
    clear(): void;
    waitForRequest(
      matcher: string | RegExp | ((req: { url: string }) => boolean),
      timeoutMs?: number,
    ): Promise<{ url: string; method: string; headers: Record<string, string> }>;
  };

  export function createRequestTracker(opts?: {
    port?: number;
    [key: string]: unknown;
  }): Promise<RequestTracker>;
}

// ─── e2e-utils/ppr ────────────────────────────────────────────────────────────
//
// Internal Next.js helper for testing Partial Pre-Rendering (PPR) responses.

declare module "e2e-utils/ppr" {
  export function splitResponseWithPPRSentinel(html: string): { shell: string; postponed: string };
}

// ─── e2e-utils/instant-validation ─────────────────────────────────────────────
//
// Internal Next.js helper for testing the "instant validation" (build-time
// error overlay) feature.

declare module "e2e-utils/instant-validation" {
  export function expectNoBuildValidationErrors(
    browser: unknown,
    opts?: Record<string, unknown>,
  ): Promise<void>;

  export function expectBuildValidationSkipped(
    browser: unknown,
    opts?: Record<string, unknown>,
  ): Promise<void>;

  export function extractBuildValidationError(
    browser: unknown,
    opts?: Record<string, unknown>,
  ): Promise<string>;

  export function parseValidationMessages(
    output: string,
    opts?: Record<string, unknown>,
  ): Array<{ type: string; message: string }>;

  export function waitForValidation(
    browser: unknown,
    opts?: Record<string, unknown>,
  ): Promise<void>;
}
