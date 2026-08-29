import { assert } from "chai";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeWebSourcePopoverRows } from "../src/modules/contextPanel/webSourceIndicators";
import { createWebFaviconImage } from "../src/modules/contextPanel/webFavicon";

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
    assert.match(
      preferences,
      /favicons are loaded from public URLs\s+supplied by Tavily/,
    );
    const tavilyCard = preferences.slice(tavilyIndex, codexIndex);
    assert.notMatch(tavilyCard, /enable-tavily|type="checkbox"/i);

    const preferenceScript = readFileSync(
      join(root, "src/modules/preferenceScript.ts"),
      "utf8",
    );
    assert.include(
      preferenceScript,
      'tavilyStatus.textContent = `${t("Connected")} · ${usage.plan}`;',
    );
    assert.notInclude(preferenceScript, 't("API key usage")');
    assert.notInclude(preferenceScript, 't("Account usage")');
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
    assert.include(css, "position: fixed");
    assert.include(css, ".llm-web-source-popover-visible");
    assert.include(css, ".llm-web-source-row + .llm-web-source-row::before");
    assert.include(
      css,
      "background: var(--stroke-secondary, rgba(120, 120, 120, 0.35))",
    );
  });

  it("exposes organization, title, safe URL, and optional favicon to each stacked row", function () {
    const rows = normalizeWebSourcePopoverRows({
      offset: 10,
      sources: [
        {
          sourceId: "web_abc1234",
          url: "https://example.com/page",
          hostname: "example.com",
          organization: "Example Organization",
          title: "Page title",
          faviconUrl: "https://example.com/favicon.ico",
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
        faviconUrl: "https://example.com/favicon.ico",
      },
    ]);
    assert.deepEqual(Object.keys(rows[0]).sort(), [
      "faviconUrl",
      "organization",
      "title",
      "url",
    ]);
  });

  it("loads only safe favicons and hides a failed image to expose the globe fallback", function () {
    let onError: (() => void) | undefined;
    const image = {
      hidden: false,
      setAttribute: () => {},
      addEventListener: (name: string, listener: () => void) => {
        if (name === "error") onError = listener;
      },
    } as unknown as HTMLImageElement;
    const doc = {
      createElement: () => image,
    } as unknown as Document;

    assert.isNull(
      createWebFaviconImage(doc, "http://127.0.0.1/favicon.ico", "favicon"),
    );
    assert.equal(
      createWebFaviconImage(doc, "https://example.com/favicon.ico", "favicon"),
      image,
    );
    assert.equal(image.src, "https://example.com/favicon.ico");
    assert.equal(image.referrerPolicy, "no-referrer");
    onError?.();
    assert.isTrue(image.hidden);
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
      'classList.toggle("expanded", pinned)',
      'addEventListener("mousedown"',
      "getBoundingClientRect()",
      "(doc.body || doc.documentElement).appendChild(popover)",
      "Zotero.launchURL(safeUrl)",
    ]) {
      assert.include(source, required);
    }
    assert.notMatch(
      source,
      /llm-web-source-(?:previous|next|carousel|pagination|counter)/,
    );
    assert.include(source, '"llm-web-source-favicon"');
    assert.notInclude(source, "source.publishedDate");
    assert.notInclude(source, "source.retrievalTime");
    assert.notInclude(source, "wrapper.append(chip, popover)");
  });

  it("uses the connected vertical trace layout for web details", function () {
    const css = readFileSync(
      join(root, "addon/content/zoteroPane.css"),
      "utf8",
    );
    assert.include(css, ".llm-agent-trace-timeline");
    assert.include(css, ".llm-agent-trace-timeline::before");
    assert.include(css, 'url("icons/action-reasoning-brain.svg")');
    assert.include(css, 'url("icons/action-mode-global.svg")');
    assert.include(css, ".llm-agent-trace-timeline-favicon");
    assert.include(css, ".llm-web-source-favicon");
    assert.match(
      css,
      /\.llm-agent-trace-timeline-favicon\s*\{[^}]*background:\s*var\(--material-sidepane,\s*var\(--material-background\)\)/s,
    );
    assert.match(
      css,
      /\.llm-web-source-favicon\s*\{[^}]*background:\s*var\(--material-background\)/s,
    );
    assert.include(css, ".llm-agent-trace-timeline-icon-has-favicon::before");
    assert.include(css, ".llm-web-source-site-icon-has-favicon::before");
    assert.include(css, "[hidden]");
    assert.include(css, "text-overflow: ellipsis");
    assert.include(css, "white-space: nowrap");
    assert.notInclude(css, ".llm-agent-trace-timeline-row-paper");
  });

  it("distinguishes literature and web activity with existing semantic icons", function () {
    const css = readFileSync(
      join(root, "addon/content/zoteroPane.css"),
      "utf8",
    );
    const libraryIcon = readFileSync(
      join(root, "addon/content/icons/action-library.svg"),
      "utf8",
    );
    assert.include(css, ".llm-at-icon-library");
    assert.include(css, 'url("icons/action-library.svg")');
    assert.include(css, ".llm-at-icon-web");
    assert.include(css, 'url("icons/action-mode-global.svg")');
    assert.include(libraryIcon, 'viewBox="0 0 16 16"');
    assert.include(libraryIcon, 'fill="currentColor"');
    assert.notInclude(libraryIcon, "490.667");
    assert.notInclude(libraryIcon, 'width="800px"');
  });
});
