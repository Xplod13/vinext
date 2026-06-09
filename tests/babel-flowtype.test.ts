/**
 * Test: Babel flowtype page compilation (#1506)
 *
 * When a `.js` file carries a `// @flow` pragma, OXC (used by
 * `vinext:jsx-in-js`) rejects it with:
 *
 *   PARSE_ERROR: Flow is not supported
 *
 * vinext must gracefully route such files through @babel/core (resolved from
 * the project root) so the project's .babelrc — which typically contains
 * @babel/preset-flow — can strip the Flow annotations before Vite continues.
 *
 * Ported from Next.js:
 *   test/e2e/babel/index.test.ts
 *   https://github.com/vercel/next.js/blob/canary/test/e2e/babel/
 */

import { describe, expect, it } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";

const FLOW_COMPONENT_CODE = `\
// @flow
import React from 'react'

type Props = {}

export default class MyComponent extends React.Component<Props> {
  render() {
    return <div id="text">Test Babel</div>
  }
}
`;

/**
 * Retrieve the vinext:jsx-in-js plugin and its transform hook from the
 * plugin array returned by vinext().
 */
function getJsxInJsPlugin(plugins: unknown[]) {
  // oxlint-disable-next-line typescript/no-explicit-any
  const flat = (plugins as any[]).flat(Infinity).filter(Boolean);
  // oxlint-disable-next-line typescript/no-explicit-any
  return flat.find((p: any) => p?.name === "vinext:jsx-in-js") ?? null;
}

describe("Babel flowtype compilation (issue #1506)", () => {
  it("vinext:jsx-in-js does not throw 'Flow is not supported' for // @flow files", async () => {
    // This test verifies that files annotated with // @flow are routed to
    // the Babel fallback path rather than OXC. When @babel/core is not
    // installed in the test environment, transformWithFlowBabel returns null
    // and the plugin returns null (graceful pass-through). The important thing
    // is that OXC is never called on the Flow-annotated code, so the
    // "Flow is not supported" PARSE_ERROR is never thrown here.
    //
    // Full e2e verification (including Babel stripping Flow types and the
    // page rendering) is covered by the deploy-suite test:
    //   test/e2e/babel/index.test.ts → "Babel > Should compile a page with
    //   flowtype correctly"

    const plugins = vinext();
    const jsxInJsPlugin = getJsxInJsPlugin([plugins]);
    expect(jsxInJsPlugin).not.toBeNull();
    expect(typeof jsxInJsPlugin.transform).toBe("function");

    // Simulate what vite:oxc would return: "Flow is not supported"
    // Before the fix, calling transform on a Flow file would delegate to OXC
    // and throw. After the fix, it delegates to transformWithFlowBabel which
    // either uses Babel (if available) or returns null (no Babel).
    // Either way, no "Flow is not supported" error should propagate.
    const result = await jsxInJsPlugin.transform(
      FLOW_COMPONENT_CODE,
      `/some/project/lib/mycomponent.js`,
    );

    // The result is either:
    //   - null if @babel/core is not installed in the project root
    //   - { code, map } if @babel/core is available and transforms the file
    // We accept both — the key assertion is that no Flow-parse error was thrown.
    expect(result).toSatisfy(
      (r: unknown) =>
        r === null || r === undefined || typeof (r as { code?: unknown }).code === "string",
    );
  });

  it("vinext:jsx-in-js transforms a non-Flow .js file with JSX normally", async () => {
    const plugins = vinext();
    const jsxInJsPlugin = getJsxInJsPlugin([plugins]);
    expect(jsxInJsPlugin).not.toBeNull();

    const result = await jsxInJsPlugin.transform(
      `export default function Hello() { return <div>Hi</div>; }`,
      `/some/project/pages/hello.js`,
    );

    // Normal JSX compilation should produce output (not null).
    expect(result).not.toBeNull();
    expect(result).not.toBeUndefined();
    expect(typeof result.code).toBe("string");
    // OXC should have compiled the JSX away — no raw JSX in the output.
    expect(result.code).not.toContain("<div>");
  });
});
