/**
 * Test: Babel flowtype page compilation (#1506)
 *
 * When a `.js` file carries a leading `// @flow` or `/* @flow *\/` pragma,
 * OXC (used by `vinext:jsx-in-js`) rejects it with:
 *
 *   PARSE_ERROR: Flow is not supported
 *
 * vinext must route such files through @babel/core (resolved from the project
 * root) so the project's .babelrc — which must contain @babel/preset-flow —
 * strips the Flow annotations before Vite continues.
 *
 * This test suite exercises `hasFlowPragma` — the detection function — in
 * isolation.  It imports from the small util module, so it never pulls in
 * `image-size` or other heavy transitive deps from the full index.ts.
 *
 * Full e2e verification (Babel stripping Flow types + page rendering) is
 * covered by the deploy-suite test:
 *   test/e2e/babel/index.test.ts → "Babel > Should compile a page with
 *   flowtype correctly"
 *
 * Ported from Next.js:
 *   test/e2e/babel/index.test.ts
 *   https://github.com/vercel/next.js/blob/canary/test/e2e/babel/
 */

import { describe, expect, it } from "vite-plus/test";
import { hasFlowPragma } from "../packages/vinext/src/utils/flow-pragma.js";

describe("hasFlowPragma — leading pragma detection (#1506)", () => {
  // ── True-positive cases ────────────────────────────────────────────────────

  it("detects `// @flow` as the very first line", () => {
    expect(hasFlowPragma("// @flow\nimport React from 'react';\n")).toBe(true);
  });

  it("detects `// @flow` after leading whitespace", () => {
    expect(hasFlowPragma("\n  // @flow\nimport React from 'react';\n")).toBe(true);
  });

  it("detects `// @flow strict` (word-boundary after @flow)", () => {
    expect(hasFlowPragma("// @flow strict\n")).toBe(true);
  });

  it("detects `// @flow` after a hashbang line", () => {
    expect(hasFlowPragma("#!/usr/bin/env node\n// @flow\n")).toBe(true);
  });

  it("detects `/* @flow */` block-comment pragma", () => {
    expect(hasFlowPragma("/* @flow */\nimport x from 'x';\n")).toBe(true);
  });

  it("detects `/** @flow */` JSDoc-style block-comment pragma", () => {
    expect(hasFlowPragma("/** @flow */\nimport x from 'x';\n")).toBe(true);
  });

  it("detects `/* @flow weak */` block-comment pragma with mode", () => {
    expect(hasFlowPragma("/* @flow weak */\n")).toBe(true);
  });

  it("detects `// @flow` after another leading line comment", () => {
    // Flow allows the pragma anywhere in the leading comment block.
    expect(hasFlowPragma("// This is a component\n// @flow\n")).toBe(true);
  });

  it("detects `/* @flow */` after a leading line comment", () => {
    expect(hasFlowPragma("// Copyright 2025\n/* @flow */\n")).toBe(true);
  });

  it("detects a real Flow component header (mycomponent.js fixture)", () => {
    const code = `// @flow
// This page is written in flowtype to test Babel's functionality
import { React } from '../namespace-exported-react'

type Props = {}

export default class MyComponent extends React.Component<Props> {
  render() {
    return <div id="text">Test Babel</div>
  }
}
`;
    expect(hasFlowPragma(code)).toBe(true);
  });

  it("detects BOM + `// @flow`", () => {
    expect(hasFlowPragma("﻿// @flow\n")).toBe(true);
  });

  // ── False-positive / false-negative cases ──────────────────────────────────

  it("does NOT match `// @flow` buried mid-file after an import statement", () => {
    const code = `import React from 'react';

// @flow
export default function Foo() { return null; }
`;
    expect(hasFlowPragma(code)).toBe(false);
  });

  it("does NOT match `@flow` inside a template literal", () => {
    const code = `const x = \`// @flow\`;
export default x;
`;
    expect(hasFlowPragma(code)).toBe(false);
  });

  it("does NOT match `@flow` inside a string literal", () => {
    const code = `const pragma = "// @flow";
export default pragma;
`;
    expect(hasFlowPragma(code)).toBe(false);
  });

  it("does NOT match a file with no @flow pragma", () => {
    expect(
      hasFlowPragma(
        `import React from 'react';\nexport default function Hello() { return <div>Hi</div>; }\n`,
      ),
    ).toBe(false);
  });

  it("does NOT match an empty file", () => {
    expect(hasFlowPragma("")).toBe(false);
  });

  it("does NOT match a file with only whitespace", () => {
    expect(hasFlowPragma("   \n\n  ")).toBe(false);
  });

  it("does NOT match `// @flow` that appears only after real code", () => {
    const code = `export const x = 1;
// @flow
`;
    expect(hasFlowPragma(code)).toBe(false);
  });

  it("does NOT match `// @flowtype` (no word-boundary after 'flow')", () => {
    // `@flowtype` is not a valid Flow pragma — the regex must use \b.
    // Note: hasFlowPragma uses `/\b@flow\b/` which matches `@flow` followed by
    // non-word char.  `@flowtype` has a word char after `flow`, so it must NOT match.
    expect(hasFlowPragma("// @flowtype\n")).toBe(false);
  });

  it("does NOT match `/* @flow */` that appears after real code", () => {
    const code = `const x = 1;\n/* @flow */\n`;
    expect(hasFlowPragma(code)).toBe(false);
  });

  // ── Edge cases ─────────────────────────────────────────────────────────────

  it("returns false for an unterminated block comment (malformed file)", () => {
    expect(hasFlowPragma("/* @flow")).toBe(false);
  });

  it("returns false for a hashbang-only file with no further content", () => {
    expect(hasFlowPragma("#!/usr/bin/env node")).toBe(false);
  });
});
