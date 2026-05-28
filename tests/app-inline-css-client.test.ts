/**
 * Unit tests for client-side inline-CSS cleanup. The browser entry calls
 * `removeStylesheetLinksCoveredByInlineCss` after every navigation commit;
 * without it, React's preinit mechanism leaves duplicate `<link>` tags for
 * stylesheets the server already inlined. Tests run against a minimal stub
 * document since vinext doesn't pull in jsdom for unit tests.
 */
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  isInlineCssStylesheetLinkElement,
  removeStylesheetLinksCoveredByInlineCss,
} from "../packages/vinext/src/server/app-inline-css-client.js";

type StubElement = {
  attrs: Record<string, string>;
  removed: boolean;
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  remove(): void;
};

function el(attrs: Record<string, string>): StubElement {
  return {
    attrs,
    removed: false,
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this.attrs, name)
        ? (this.attrs[name] ?? "")
        : null;
    },
    hasAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this.attrs, name);
    },
    remove() {
      this.removed = true;
    },
  };
}

function installDocument(opts: { styles: StubElement[]; links: StubElement[] }): void {
  const { styles, links } = opts;
  const head = {
    querySelectorAll<T extends Element>(selector: string): T[] {
      if (selector === "style[data-vinext-inline-css]") {
        return styles.filter((s) => s.hasAttribute("data-vinext-inline-css")) as unknown as T[];
      }
      if (selector === "link[rel][href]") {
        return links.filter(
          (l) => l.hasAttribute("rel") && l.hasAttribute("href"),
        ) as unknown as T[];
      }
      throw new Error(`Unexpected selector: ${selector}`);
    },
  };
  vi.stubGlobal("document", { head });
  vi.stubGlobal("window", { location: { href: "https://example.com/" } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("isInlineCssStylesheetLinkElement", () => {
  it('matches rel="stylesheet" with an href', () => {
    expect(isInlineCssStylesheetLinkElement(el({ rel: "stylesheet", href: "/a.css" }))).toBe(true);
  });

  it("matches tokenized rel values containing stylesheet", () => {
    expect(
      isInlineCssStylesheetLinkElement(el({ rel: "preload stylesheet", href: "/a.css" })),
    ).toBe(true);
  });

  it('rejects rel="preload" alone', () => {
    expect(isInlineCssStylesheetLinkElement(el({ rel: "preload", href: "/a.css" }))).toBe(false);
  });

  it("rejects stylesheet links missing href", () => {
    expect(isInlineCssStylesheetLinkElement(el({ rel: "stylesheet" }))).toBe(false);
  });
});

describe("removeStylesheetLinksCoveredByInlineCss", () => {
  it("removes link tags whose href matches an inline style's data attribute", () => {
    const covered = el({ rel: "stylesheet", href: "/_next/static/app.css" });
    const uncovered = el({ rel: "stylesheet", href: "/_next/static/other.css" });
    const tokenized = el({ rel: "preload stylesheet", href: "/_next/static/route.css" });
    installDocument({
      styles: [
        el({ "data-vinext-inline-css": "/_next/static/app.css" }),
        el({ "data-vinext-inline-css": "/_next/static/route.css" }),
      ],
      links: [covered, uncovered, tokenized],
    });

    removeStylesheetLinksCoveredByInlineCss();

    expect(covered.removed).toBe(true);
    expect(tokenized.removed).toBe(true);
    expect(uncovered.removed).toBe(false);
  });

  it("matches an absolute-URL link against a path-keyed inline style", () => {
    // assetPrefix may serve CSS at https://cdn… but inline <style> stores
    // the path — both must resolve to the same absolute URL and dedupe.
    const link = el({ rel: "stylesheet", href: "https://example.com/_next/static/app.css" });
    installDocument({
      styles: [el({ "data-vinext-inline-css": "/_next/static/app.css" })],
      links: [link],
    });

    removeStylesheetLinksCoveredByInlineCss();

    expect(link.removed).toBe(true);
  });

  it("is a no-op when no inline-css styles exist", () => {
    const link = el({ rel: "stylesheet", href: "/_next/static/app.css" });
    installDocument({ styles: [], links: [link] });

    removeStylesheetLinksCoveredByInlineCss();

    expect(link.removed).toBe(false);
  });
});
