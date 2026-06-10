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
 * This test suite exercises both halves of the feature:
 *
 *   1. `hasFlowPragma` — the detection function — in isolation. It imports
 *      from the small util module, so it never pulls in `image-size` or other
 *      heavy transitive deps from the full index.ts.
 *   2. `transformWithFlowBabel` — the actual two-stage transform (Babel
 *      strips Flow types via the project's .babelrc, then an OXC re-pass
 *      compiles the JSX) — driven against the workspace fixture
 *      `tests/fixtures/babel-flowtype/`, which declares @babel/core +
 *      @babel/preset-flow as its own deps the way a real user project would.
 *
 * Additional e2e verification (full page rendering) is covered by the
 * deploy-suite test:
 *   test/e2e/babel/index.test.ts → "Babel > Should compile a page with
 *   flowtype correctly"
 *
 * Ported from Next.js:
 *   test/e2e/babel/index.test.ts
 *   https://github.com/vercel/next.js/blob/canary/test/e2e/babel/
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { hasFlowPragma } from "../packages/vinext/src/utils/flow-pragma.js";
import { transformWithFlowBabel } from "../packages/vinext/src/utils/flow-babel.js";

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
    // Note: hasFlowPragma uses `/@flow\b/` which matches `@flow` followed by
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

describe("transformWithFlowBabel — Babel + OXC two-stage transform (#1506)", () => {
  const FIXTURE_ROOT = path.resolve(import.meta.dirname, "./fixtures/babel-flowtype");
  const FIXTURE_FILE = path.join(FIXTURE_ROOT, "pages", "mycomponent.js");
  const fixtureCode = fs.readFileSync(FIXTURE_FILE, "utf8");

  it("strips Flow type annotations using the fixture project's .babelrc", async () => {
    // Sanity: the fixture really is a Flow file with a leading pragma.
    expect(hasFlowPragma(fixtureCode)).toBe(true);
    expect(fixtureCode).toContain("type Props");

    const result = await transformWithFlowBabel(fixtureCode, FIXTURE_FILE, FIXTURE_ROOT);
    expect(result).not.toBeNull();
    // Flow-only syntax must be gone from the output.
    expect(result!.code).not.toContain("type Props");
    expect(result!.code).not.toContain("Component<Props>");
    expect(result!.code).not.toContain(": React.Node");
  });

  it("compiles the JSX left in Babel's output via the OXC re-pass", async () => {
    const result = await transformWithFlowBabel(fixtureCode, FIXTURE_FILE, FIXTURE_ROOT);
    expect(result).not.toBeNull();
    // Raw JSX must be compiled away to automatic-runtime calls.
    expect(result!.code).not.toContain("<div");
    expect(result!.code).toContain("react/jsx-runtime");
    expect(result!.code).toContain("Test Babel");
  });

  it("returns a sourcemap that traces back to the original Flow source", async () => {
    const result = await transformWithFlowBabel(fixtureCode, FIXTURE_FILE, FIXTURE_ROOT);
    expect(result).not.toBeNull();
    const map = result!.map as { sources?: string[]; sourcesContent?: (string | null)[] };
    expect(map).toBeTruthy();
    // The composed map must point at the original file — not at Babel's
    // intermediate output — proving the Babel map was chained into the OXC
    // pass rather than discarded.
    expect(map.sources?.some((s) => s.includes("mycomponent.js"))).toBe(true);
    expect(map.sourcesContent?.some((c) => c?.includes("type Props"))).toBe(true);
  });

  it("returns null when @babel/core is not resolvable from the project root", async () => {
    const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-flow-babel-"));
    try {
      const file = path.join(emptyRoot, "page.js");
      expect(await transformWithFlowBabel(fixtureCode, file, emptyRoot)).toBeNull();
      // Second call exercises the memoized "not found" path.
      expect(await transformWithFlowBabel(fixtureCode, file, emptyRoot)).toBeNull();
    } finally {
      fs.rmSync(emptyRoot, { recursive: true, force: true });
    }
  });
});
