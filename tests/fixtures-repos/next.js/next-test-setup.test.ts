/**
 * Unit tests for next-test-setup.ts
 *
 * Tests two things:
 *
 * 1. cheerio.load() — sanity-checks that the real cheerio package works as
 *    expected for the selectors Next.js tests use. These run without any server.
 *
 * 2. nextTestSetup smoke test — spins up a vinext dev server against the
 *    app-basic fixture (the same one used by nextjs-compat tests) and verifies
 *    that next.render, next.render$, next.fetch, and next.browser all work.
 *    This lives in the "integration" project because it starts a Vite server.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { load as cheerioLoad } from "cheerio";
import { nextTestSetup } from "./next-test-setup.js";
import path from "node:path";

// ─── cheerio unit tests ───────────────────────────────────────────────────────

describe("cheerio.load", () => {
  const html = `
    <!doctype html>
    <html>
      <head><title>Test Page</title></head>
      <body>
        <h1 id="title" class="heading large">Hello World</h1>
        <p class="text">First paragraph</p>
        <p class="text secondary">Second paragraph</p>
        <a href="/about" data-testid="nav-link">About</a>
        <img src="/logo.png" alt="Logo" />
        <div id="container">
          <span class="inner">nested span</span>
        </div>
        <input type="text" value="hello" />
        <br />
      </body>
    </html>
  `;

  // ── $.html() ───────────────────────────────────────────────────────────────

  it("$.html() returns the serialised document HTML", () => {
    const $ = cheerioLoad(html);
    // cheerio serialises the document — it won't be byte-for-byte identical to
    // the input but must contain the key content we care about.
    const out = $.html();
    expect(out).toContain("Hello World");
    expect(out).toContain("First paragraph");
    expect(out).toContain('id="title"');
  });

  // ── tag selector ──────────────────────────────────────────────────────────

  it("tag selector matches elements by tag name", () => {
    const $ = cheerioLoad(html);
    expect($("h1").length).toBe(1);
    expect($("p").length).toBe(2);
    expect($("a").length).toBe(1);
  });

  it("tag selector .text() returns concatenated inner text", () => {
    const $ = cheerioLoad(html);
    expect($("h1").text()).toBe("Hello World");
    expect($("a").text()).toBe("About");
  });

  it("tag selector .html() returns inner HTML of first match", () => {
    const $ = cheerioLoad(html);
    expect($("h1").html()).toBe("Hello World");
  });

  it("tag selector .html() returns null when no match", () => {
    const $ = cheerioLoad(html);
    expect($("section").html()).toBeNull();
  });

  it("tag selector .length is 0 for unmatched selectors", () => {
    const $ = cheerioLoad(html);
    expect($("nav").length).toBe(0);
  });

  // ── #id selector ──────────────────────────────────────────────────────────

  it("#id selector matches element with that id", () => {
    const $ = cheerioLoad(html);
    expect($("#title").length).toBe(1);
    expect($("#title").text()).toBe("Hello World");
  });

  it("#id selector returns empty when id not found", () => {
    const $ = cheerioLoad(html);
    expect($("#nope").length).toBe(0);
    expect($("#nope").text()).toBe("");
  });

  // ── .class selector ───────────────────────────────────────────────────────

  it(".class selector matches elements with that class", () => {
    const $ = cheerioLoad(html);
    expect($(".text").length).toBe(2);
  });

  it(".class selector .text() concatenates text of all matches", () => {
    const $ = cheerioLoad(html);
    expect($(".text").text()).toBe("First paragraphSecond paragraph");
  });

  it(".class selector matches when element has multiple classes", () => {
    const $ = cheerioLoad(html);
    // .secondary only matches the second paragraph
    expect($(".secondary").length).toBe(1);
    expect($(".secondary").text()).toBe("Second paragraph");
  });

  // ── .attr() ───────────────────────────────────────────────────────────────

  it(".attr() returns the attribute value of the first match", () => {
    const $ = cheerioLoad(html);
    expect($("a").attr("href")).toBe("/about");
    expect($("a").attr("data-testid")).toBe("nav-link");
  });

  it(".attr() returns undefined when attribute is missing", () => {
    const $ = cheerioLoad(html);
    expect($("a").attr("nonexistent")).toBeUndefined();
  });

  it(".attr() returns undefined when selector has no matches", () => {
    const $ = cheerioLoad(html);
    expect($("nav").attr("href")).toBeUndefined();
  });

  // ── combined selectors ────────────────────────────────────────────────────

  it("tag + #id combined selector (e.g. h1#title)", () => {
    const $ = cheerioLoad(html);
    expect($("h1#title").length).toBe(1);
    expect($("h1#title").text()).toBe("Hello World");
  });

  it("tag + .class combined selector (e.g. p.text)", () => {
    const $ = cheerioLoad(html);
    expect($("p.text").length).toBe(2);
  });

  it("#id + .class combined selector (e.g. h1.heading)", () => {
    const $ = cheerioLoad(html);
    expect($("#title.heading").length).toBe(1);
  });

  it("multiple .class combined selector (e.g. .text.secondary)", () => {
    const $ = cheerioLoad(html);
    expect($(".text.secondary").length).toBe(1);
    expect($(".text.secondary").text()).toBe("Second paragraph");
  });

  // ── [attr] and [attr=val] selectors ───────────────────────────────────────

  it("[attr] selector matches elements that have the attribute", () => {
    const $ = cheerioLoad(html);
    expect($("[href]").length).toBe(1);
    expect($("[href]").text()).toBe("About");
  });

  it("[attr=val] selector matches elements with the exact attribute value", () => {
    const $ = cheerioLoad(html);
    expect($("[data-testid=nav-link]").length).toBe(1);
    expect($("[data-testid=nav-link]").text()).toBe("About");
  });

  // ── void / self-closing elements ──────────────────────────────────────────

  it("void elements (img, input, br) are matched with empty inner", () => {
    const $ = cheerioLoad(html);
    expect($("img").length).toBe(1);
    expect($("img").attr("src")).toBe("/logo.png");
    expect($("img").attr("alt")).toBe("Logo");
    expect($("img").text()).toBe("");
    expect($("br").length).toBe(1);
  });

  // ── nested inner HTML ─────────────────────────────────────────────────────

  it("inner HTML of a container element includes child tags", () => {
    const $ = cheerioLoad(html);
    const inner = $("#container").html();
    expect(inner).toBeTruthy();
    expect(inner).toContain("nested span");
    expect(inner).toContain("<span");
  });

  // ── entity decoding ───────────────────────────────────────────────────────

  it(".text() decodes HTML entities", () => {
    const encoded = `<p id="msg">Hello &amp; World &lt;3&gt;</p>`;
    const $ = cheerioLoad(encoded);
    expect($("#msg").text()).toBe("Hello & World <3>");
  });

  it(".attr() decodes HTML entities in attribute values", () => {
    const encoded = `<a href="/path?a=1&amp;b=2">link</a>`;
    const $ = cheerioLoad(encoded);
    expect($("a").attr("href")).toBe("/path?a=1&b=2");
  });

  // ── descendant selector ───────────────────────────────────────────────────

  it("supports descendant (space) selectors", () => {
    const $ = cheerioLoad(html);
    expect($("div span").length).toBe(1);
    expect($("div span").text()).toBe("nested span");
  });

  // ── edge cases ────────────────────────────────────────────────────────────

  it("handles empty HTML gracefully", () => {
    const $ = cheerioLoad("");
    expect($("h1").length).toBe(0);
    // cheerio always produces a valid document skeleton even for empty input
    expect(typeof $.html()).toBe("string");
  });

  it("handles HTML with no matching tags", () => {
    const $ = cheerioLoad("<p>only paragraphs</p>");
    expect($("h1").length).toBe(0);
    expect($("p").length).toBe(1);
    expect($("p").text()).toBe("only paragraphs");
  });

  it("handles deeply nested elements correctly", () => {
    const nested = `
      <div id="outer">
        <div id="middle">
          <p id="inner">deep text</p>
        </div>
      </div>
    `;
    const $ = cheerioLoad(nested);
    expect($("#inner").text()).toBe("deep text");
    const outerHtml = $("#outer").html();
    expect(outerHtml).toContain("middle");
    expect(outerHtml).toContain("deep text");
  });

  it("multiple same-tag elements are all returned", () => {
    const multi = `<li>one</li><li>two</li><li>three</li>`;
    const $ = cheerioLoad(multi);
    expect($("li").length).toBe(3);
    expect($("li").text()).toBe("onetwothree");
    expect($("li").first().html()).toBe("one");
  });
});

// ─── nextTestSetup smoke tests ────────────────────────────────────────────────
//
// These tests live in the "integration" Vitest project (see vite.config.ts).
// They start a real Vite dev server and verify the full next.* API works.

const APP_FIXTURE = path.resolve(import.meta.dirname, "./fixtures/app-basic");

describe("nextTestSetup — smoke test", () => {
  const { next, isNextDev, isNextStart, isNextDeploy, isTurbopack, skipped } = nextTestSetup({
    files: APP_FIXTURE,
  });

  // ── flags ──────────────────────────────────────────────────────────────────

  it("returns correct mode flags", () => {
    expect(isNextDev).toBe(true);
    expect(isNextStart).toBe(false);
    expect(isNextDeploy).toBe(false);
    expect(isTurbopack).toBe(false);
    expect(skipped).toBe(false);
  });

  it("next.url is a non-empty localhost URL after server start", () => {
    expect(next.url).toMatch(/^http:\/\/localhost:\d+$/);
  });

  // ── next.fetch ─────────────────────────────────────────────────────────────

  it("next.fetch('/') returns a 200 response", async () => {
    const res = await next.fetch("/");
    expect(res.status).toBe(200);
  });

  it("next.fetch accepts a full URL (next.url + path)", async () => {
    const res = await next.fetch(next.url + "/");
    expect(res.status).toBe(200);
  });

  it("next.fetch('/nonexistent-route-xyz') returns 404", async () => {
    const res = await next.fetch("/nonexistent-route-xyz-abc");
    expect(res.status).toBe(404);
  });

  // ── next.render ────────────────────────────────────────────────────────────

  it("next.render('/') returns HTML string", async () => {
    const html = await next.render("/");
    expect(typeof html).toBe("string");
    expect(html.length).toBeGreaterThan(0);
    expect(html).toContain("<!DOCTYPE html>");
  });

  it("next.render passes custom fetch init (e.g. headers)", async () => {
    // Sending an RSC request header should return text/x-component, not HTML
    const html = await next.render("/", {
      headers: { RSC: "1", Accept: "text/x-component" },
    });
    // RSC response is not an HTML document
    expect(html).not.toContain("<!DOCTYPE html>");
    // It should contain RSC payload markers
    expect(html.length).toBeGreaterThan(0);
  });

  // ── next.render$ ───────────────────────────────────────────────────────────

  it("next.render$('/') returns a cheerio function", async () => {
    const $ = await next.render$("/");
    expect(typeof $).toBe("function");
    expect(typeof $.html).toBe("function");
  });

  it("next.render$ $.html() returns the full HTML", async () => {
    const $ = await next.render$("/");
    const html = $.html();
    expect(html).toContain("<!DOCTYPE html>");
  });

  it("next.render$ selector returns matching elements", async () => {
    const $ = await next.render$("/");
    // Every Next.js page has an <html> element
    expect($("html").length).toBeGreaterThan(0);
    // And a <body>
    expect($("body").length).toBeGreaterThan(0);
  });

  // ── next.browser ───────────────────────────────────────────────────────────

  it("next.browser('/') navigates and returns a BrowserInstance", async () => {
    const browser = await next.browser("/");
    try {
      const url = await browser.url();
      expect(url).toContain("localhost");
    } finally {
      await browser.close();
    }
  });

  it("browser.eval() executes JavaScript in the page", async () => {
    const browser = await next.browser("/");
    try {
      const result = await browser.eval("1 + 1");
      expect(result).toBe(2);
    } finally {
      await browser.close();
    }
  });

  it("browser.elementByCss('body').text() returns page text", async () => {
    const browser = await next.browser("/");
    try {
      const text = await browser.elementByCss("body").text();
      expect(typeof text).toBe("string");
      expect(text.length).toBeGreaterThan(0);
    } finally {
      await browser.close();
    }
  });

  it("browser.hasElementByCssSelector returns true for existing elements", async () => {
    const browser = await next.browser("/");
    try {
      expect(await browser.hasElementByCssSelector("body")).toBe(true);
      expect(await browser.hasElementByCssSelector("html")).toBe(true);
    } finally {
      await browser.close();
    }
  });

  it("browser.hasElementByCssSelector returns false for missing elements", async () => {
    const browser = await next.browser("/");
    try {
      expect(
        await browser.hasElementByCssSelector("#this-element-definitely-does-not-exist-xyz"),
      ).toBe(false);
    } finally {
      await browser.close();
    }
  });

  it("browser.log() returns an array of console log entries", async () => {
    const browser = await next.browser("/");
    try {
      const logs = await browser.log();
      expect(Array.isArray(logs)).toBe(true);
    } finally {
      await browser.close();
    }
  });

  it("browser.refresh() reloads without throwing", async () => {
    const browser = await next.browser("/");
    try {
      const urlBefore = await browser.url();
      await browser.refresh();
      const urlAfter = await browser.url();
      expect(urlAfter).toBe(urlBefore);
    } finally {
      await browser.close();
    }
  });

  it("browser.loadPage() navigates to a new URL", async () => {
    const browser = await next.browser("/");
    try {
      await browser.loadPage(next.url + "/");
      const url = await browser.url();
      expect(url).toContain("localhost");
    } finally {
      await browser.close();
    }
  });
});
