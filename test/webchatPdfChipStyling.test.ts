import { assert } from "chai";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getContextSourceModeCssClassName } from "../src/modules/contextPanel/contextSourceModes";

const testDir = dirname(fileURLToPath(import.meta.url));

function source(path: string): string {
  return readFileSync(resolve(testDir, "..", path), "utf8");
}

describe("WebChat PDF chip styling", function () {
  it("keeps the PDF source class after its one-shot upload is consumed", function () {
    const setupHandlers = source("src/modules/contextPanel/setupHandlers.ts");

    assert.equal(
      getContextSourceModeCssClassName("pdf"),
      "llm-paper-context-chip-pdf",
    );
    assert.notMatch(
      setupHandlers,
      /isWebChatMode\(\)\s*&&\s*contentSourceMode\s*===\s*"pdf"\s*&&\s*!fullText\s*\?\s*"text"/,
    );
    assert.match(
      setupHandlers,
      /chip\.classList\.toggle\(\s*"llm-paper-context-chip-webchat-inactive",\s*isWebChatMode\(\)\s*&&\s*contentSourceMode\s*===\s*"pdf"\s*&&\s*!fullText,/,
    );
  });

  it("keeps the inactive WebChat surface neutral without changing PDF purple", function () {
    const css = source("addon/content/zoteroPane.css");

    assert.match(
      css,
      /\.llm-paper-context-chip\.llm-paper-context-chip-pdf\s+\.llm-paper-context-chip-icon\s*\{[\s\S]*?color:\s*var\(--llm-pdf-color\);/,
    );
    assert.match(
      css,
      /\.llm-paper-context-chip\.llm-paper-context-chip-pdf\.llm-paper-context-chip-webchat-inactive\s+\.llm-paper-context-chip-header\s*\{[\s\S]*?background:\s*transparent;/,
    );
  });
});
