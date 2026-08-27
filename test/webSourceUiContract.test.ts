import { assert } from "chai";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeWebSourcePopoverRows } from "../src/modules/contextPanel/webSourceIndicators";

describe("web source UI contract", function () {
  const root = process.cwd();

  it("places the shared-style Tavily card immediately before Codex App Server", function () {
    const preferences = readFileSync(
      join(root, "addon/content/preferences.xhtml"),
      "utf8",
    );
    const tavilyIndex = preferences.indexOf('id="__addonRef__-tavily-card"');
    const codexIndex = preferences.indexOf(
      'id="__addonRef__-codex-app-server-card"',
    );
    assert.isAtLeast(tavilyIndex, 0);
    assert.isAbove(codexIndex, tavilyIndex);
    assert.include(preferences, 'id="__addonRef__-tavily-api-key"');
    assert.include(preferences, 'type="password"');
    assert.include(preferences, "Test connection");
    assert.include(preferences, "Get a free API key");
    assert.include(preferences, "Basic search costs 1 Tavily credit");
    assert.match(preferences, /retention,\s+and search-index\s+policies/);
    const tavilyCard = preferences.slice(tavilyIndex, codexIndex);
    assert.notMatch(tavilyCard, /enable-tavily|type="checkbox"/i);
  });

  it("uses the existing paper-card surface and selectable-row primitives", function () {
    const css = readFileSync(
      join(root, "addon/content/zoteroPane.css"),
      "utf8",
    );
    assert.match(css, /\.llm-paper-picker-item,\s*\.llm-web-source-row\s*\{/);
    assert.match(
      css,
      /\.llm-selected-context-expanded,\s*\.llm-web-source-popover\s*\{/,
    );
    assert.include(css, 'url("icons/action-mode-global.svg")');
    assert.include(css, "background: var(--material-background)");
    assert.include(css, "border: 1px solid var(--stroke-secondary)");
    assert.include(css, "max-height: min(52vh, 320px)");
    assert.include(css, "overflow-y: auto");
  });

  it("exposes only organization, title, and safe URL to each stacked row", function () {
    const rows = normalizeWebSourcePopoverRows({
      offset: 10,
      sources: [
        {
          sourceId: "web_abc1234",
          url: "https://example.com/page",
          hostname: "example.com",
          organization: "Example Organization",
          title: "Page title",
        },
        {
          sourceId: "web_bad1234",
          url: "http://127.0.0.1/private",
          hostname: "127.0.0.1",
          organization: "Private",
          title: "Private page",
        },
      ],
    });
    assert.deepEqual(rows, [
      {
        organization: "Example Organization",
        title: "Page title",
        url: "https://example.com/page",
      },
    ]);
    assert.deepEqual(Object.keys(rows[0]).sort(), [
      "organization",
      "title",
      "url",
    ]);
  });

  it("implements hover, focus, pin, Escape, outside-click, clamp, and URL launch behavior", function () {
    const source = readFileSync(
      join(root, "src/modules/contextPanel/webSourceIndicators.ts"),
      "utf8",
    );
    for (const required of [
      'addEventListener("mouseenter"',
      'addEventListener("focusin"',
      'addEventListener("focusout"',
      'event.key !== "Escape"',
      'classList.toggle("expanded")',
      'addEventListener("mousedown"',
      "getBoundingClientRect()",
      "Zotero.launchURL(safeUrl)",
    ]) {
      assert.include(source, required);
    }
    assert.notMatch(
      source,
      /llm-web-source-(?:previous|next|carousel|pagination|counter|favicon)/,
    );
    assert.notInclude(source, "source.publishedDate");
    assert.notInclude(source, "source.retrievalTime");
  });
});
