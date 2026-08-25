import { readFileSync } from "node:fs";
import { assert } from "chai";

describe("Codex Direct UI integration", function () {
  const preferenceScript = readFileSync(
    "src/modules/preferenceScript.ts",
    "utf8",
  );
  const setupHandlers = readFileSync(
    "src/modules/contextPanel/setupHandlers.ts",
    "utf8",
  );

  it("renders a dedicated minimal settings card before generic model controls", function () {
    const start = preferenceScript.indexOf(
      'if (group.authMode === "codex_auth") {\n        group.apiBase = CODEX_DIRECT_RESPONSES_URL;',
    );
    const end = preferenceScript.indexOf("// ── Provider preset", start);
    assert.isAtLeast(start, 0);
    assert.isAbove(end, start);
    const directCard = preferenceScript.slice(start, end);
    assert.include(directCard, 't("Test connection")');
    assert.include(directCard, "runCodexDirectConnectionTest");
    assert.include(directCard, "cardBody.append(authModeWrap, testWrap)");
    assert.notInclude(directCard, "providerPresetWrap");
    assert.notInclude(directCard, "apiUrlWrap");
    assert.notInclude(directCard, "modelsWrap");
    assert.notInclude(directCard, "advGearBtn");
  });

  it("describes the direct mode without implying App Server controls", function () {
    assert.include(preferenceScript, 't("Codex Direct (Legacy)")');
    assert.include(preferenceScript, "credentials from `codex login`");
    assert.include(preferenceScript, "does not provide App Server sessions");
    assert.include(preferenceScript, "sandbox controls, approvals");
  });

  it("uses the generic model loop and shared reasoning button renderer", function () {
    assert.include(setupHandlers, "getAvailableModelEntries()");
    assert.include(setupHandlers, "for (const group of groupedChoices)");
    assert.include(setupHandlers, "for (const entry of group.entries)");
    assert.include(setupHandlers, "appendCodexDirectCatalogStatus(modelMenu)");
    assert.include(setupHandlers, "subscribeToCodexDirectCatalog");
    assert.equal(
      setupHandlers.split("appendReasoningChoiceButtons({").length - 1,
      2,
    );
  });
});
