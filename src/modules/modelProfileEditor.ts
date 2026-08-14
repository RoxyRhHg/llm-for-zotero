/**
 * Model parameter controls, rendered inline in a provider card's advanced row.
 *
 * Every heuristic for guessing what a model can do goes stale as models ship,
 * so the user gets the last word. This owns the parts of the advanced row that
 * back a `ModelProfileOverride`; temperature, max tokens, input cap, input mode
 * and the protocol override stay where they already were, and are deliberately
 * *not* duplicated here.
 *
 * **Reasoning levels are a list the user builds**, not a fixed ladder of
 * checkboxes. When nothing has been customized the list is seeded from the
 * detected profile — so the rows start out matching what the model actually
 * offers, complete with real parameters — and the user then edits, deletes or
 * adds rows. That keeps a level from ever existing without the request body
 * that gives it meaning.
 *
 * **Absent stays distinguishable from empty.** `pruneProfileOverride` drops
 * empty sections so nothing is stored as `{}`, which is what makes Reset
 * indistinguishable from never having edited.
 */

import {
  parseJsonObjectField,
  parseKeyValueField,
  pruneProfileOverride,
  stringifyJsonObjectField,
  stringifyKeyValueField,
  type ModelProfileOverride,
  type ResolvedModelCapabilities,
} from "../modelCapabilities";

const HTML_NS = "http://www.w3.org/1999/xhtml";

/**
 * Suggestions only — the level id is free text.
 *
 * Providers introduce new effort values (`ultra` and whatever follows), and a
 * fixed dropdown would make the plugin the bottleneck for adopting them. These
 * populate a datalist so the common levels stay one keystroke away without
 * being the only choices.
 */
export const SUGGESTED_REASONING_LEVEL_IDS = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "default",
] as const;

/** Matches the pref-store validator in prefHelpers, so a level is remembered. */
const LEVEL_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;

const TRISTATE_AUTO = "";
const TRISTATE_ON = "on";
const TRISTATE_OFF = "off";

export type ModelProfileEditorHandle = {
  element: HTMLElement;
  /** Re-read the detected profile and repaint. */
  refresh: (capabilities: ResolvedModelCapabilities) => void;
};

type EditorDeps = {
  doc: Document;
  getOverride: () => ModelProfileOverride | undefined;
  /** Persist a new override; `undefined` clears it entirely. */
  onChange: (next: ModelProfileOverride | undefined) => void;
  /** The profile as detected, used to seed the level list and for Reset. */
  getDetected: () => ResolvedModelCapabilities;
  t: (text: string) => string;
  styles: {
    input: string;
    inputSm: string;
    helper: string;
    sectionLabel: string;
    outlineBtn: string;
  };
};

type ReasoningRow = {
  wrap: HTMLElement;
  id: HTMLInputElement;
  params: HTMLInputElement;
  warning: HTMLElement;
};

function el<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  style?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = doc.createElementNS(HTML_NS, tag) as HTMLElementTagNameMap[K];
  if (style) node.setAttribute("style", style);
  if (text !== undefined) node.textContent = text;
  return node;
}

function readTristate(select: HTMLSelectElement): boolean | undefined {
  if (select.value === TRISTATE_ON) return true;
  if (select.value === TRISTATE_OFF) return false;
  return undefined;
}

function tristateValue(value: boolean | undefined): string {
  if (value === true) return TRISTATE_ON;
  if (value === false) return TRISTATE_OFF;
  return TRISTATE_AUTO;
}

type ComparableOption = {
  id: string;
  controls?: { body?: Record<string, unknown> };
};

/** Order-sensitive comparison of id + request body; labels are cosmetic. */
function sameOptionSet(
  left: readonly ComparableOption[],
  right: readonly ComparableOption[],
): boolean {
  if (left.length !== right.length) return false;
  const shape = (options: readonly ComparableOption[]) =>
    JSON.stringify(
      options.map((option) => [option.id, option.controls?.body || {}]),
    );
  return shape(left) === shape(right);
}

export function createModelProfileEditor(
  deps: EditorDeps,
): ModelProfileEditorHandle {
  const { doc, t, styles } = deps;
  const root = el(
    doc,
    "div",
    "display: flex; flex-direction: column; gap: 10px; margin-top: 2px;",
  );

  let detected = deps.getDetected();
  let suspendCommit = false;

  /** The label detection gave this level, so the menu keeps its off/on wording. */
  function detectedLabelFor(id: string): string {
    return (
      detected.reasoning.options.find((option) => option.id === id)?.label || ""
    );
  }

  /**
   * The parameter key this provider actually uses, read from whatever the
   * detected profile sends. Ollama's options carry `think`, so a hint of
   * `reasoning_effort=…` there would be wrong; hosted providers carry no
   * controls at all, and `reasoning_effort` is the right guess for them.
   */
  function detectedParameterKey(): string {
    for (const option of detected.reasoning.options) {
      const key = Object.keys(option.controls?.body || {})[0];
      if (key) return key;
    }
    return "reasoning_effort";
  }

  /** Hint the shape for *this* row, not a fixed example. */
  function paramsPlaceholderFor(id: string): string {
    const level = id.trim() || "high";
    return `${detectedParameterKey()}=${level}`;
  }

  const sectionLabel = (title: string) =>
    el(doc, "div", styles.sectionLabel, t(title));

  const hint = (text: string) => el(doc, "span", styles.helper, t(text));

  // ── Capabilities ──────────────────────────────────────────────────────────
  // Vision is intentionally absent: the existing "Input mode" control in this
  // same row already governs it, and two controls for one thing invites them
  // to disagree.
  const capsRow = el(
    doc,
    "div",
    "display: flex; gap: 10px; flex-wrap: wrap; align-items: flex-end;",
  );

  const tristateField = (labelText: string) => {
    const wrap = el(
      doc,
      "div",
      "display: flex; flex-direction: column; gap: 3px;",
    );
    wrap.append(
      el(
        doc,
        "label",
        "font-size: 10.5px; font-weight: 600; color: var(--fill-primary, inherit);",
        t(labelText),
      ),
    );
    const select = el(doc, "select", styles.inputSm) as HTMLSelectElement;
    for (const [value, optionLabel] of [
      [TRISTATE_AUTO, "Auto"],
      [TRISTATE_ON, "Yes"],
      [TRISTATE_OFF, "No"],
    ]) {
      const option = el(doc, "option") as HTMLOptionElement;
      option.value = value;
      option.textContent = t(optionLabel);
      select.appendChild(option);
    }
    select.addEventListener("change", commit);
    wrap.append(select);
    return { wrap, select };
  };

  const toolsField = tristateField("Tools");
  const streamingField = tristateField("Streaming");
  const pdfField = tristateField("PDF");
  capsRow.append(toolsField.wrap, streamingField.wrap, pdfField.wrap);

  // ── Reasoning levels ──────────────────────────────────────────────────────
  const reasoningWrap = el(
    doc,
    "div",
    "display: flex; flex-direction: column; gap: 6px;",
  );
  const reasoningHeader = el(
    doc,
    "div",
    "display: flex; align-items: center; gap: 8px;",
  );
  const addLevelBtn = el(
    doc,
    "button",
    styles.outlineBtn,
    t("+ Add level"),
  ) as HTMLButtonElement;
  addLevelBtn.type = "button";
  reasoningHeader.append(sectionLabel("Reasoning levels"), addLevelBtn);
  const reasoningList = el(
    doc,
    "div",
    "display: flex; flex-direction: column; gap: 4px;",
  );
  // A datalist rather than a dropdown: the common levels stay one keystroke
  // away, but a provider's newly-introduced level (ultra, and whatever comes
  // next) can be typed in without waiting for a plugin release.
  const levelSuggestionsId = `llm-reasoning-levels-${Math.floor(
    Date.now() % 1_000_000,
  )}`;
  const levelSuggestions = el(doc, "datalist");
  levelSuggestions.id = levelSuggestionsId;
  for (const levelId of SUGGESTED_REASONING_LEVEL_IDS) {
    const option = el(doc, "option") as HTMLOptionElement;
    option.value = levelId;
    levelSuggestions.appendChild(option);
  }

  reasoningWrap.append(
    reasoningHeader,
    hint(
      "The levels the reasoning menu offers, and the parameters each one sends " +
        "— for example reasoning_effort=high, or think=high on Ollama. " +
        "For an off switch add a level named off that disables it: " +
        "reasoning_effort=none, or think=false on Ollama. Leaving a level's " +
        "parameters blank uses the provider's default, which is not the same " +
        "as off.",
    ),
    levelSuggestions,
    reasoningList,
  );

  let reasoningRows: ReasoningRow[] = [];

  function addReasoningRow(seed?: { id: string; params: string }) {
    const wrap = el(
      doc,
      "div",
      "display: flex; gap: 6px; align-items: center; flex-wrap: wrap;",
    );
    const idInput = el(doc, "input", styles.inputSm) as HTMLInputElement;
    idInput.type = "text";
    idInput.style.width = "104px";
    idInput.setAttribute("list", levelSuggestionsId);
    idInput.placeholder = t("level");
    idInput.value = seed?.id || firstUnusedLevelId();

    const params = el(
      doc,
      "input",
      styles.inputSm + " width: 260px; font-family: monospace;",
    ) as HTMLInputElement;
    params.type = "text";
    params.placeholder = paramsPlaceholderFor(idInput.value);
    params.value = seed?.params || "";
    params.addEventListener("input", commit);

    idInput.addEventListener("input", () => {
      // The hint follows the level, so each row suggests its own value rather
      // than repeating one example down the whole list.
      params.placeholder = paramsPlaceholderFor(idInput.value);
      commit();
    });

    const removeBtn = el(
      doc,
      "button",
      "padding: 0; width: 22px; height: 22px; border: none; background: transparent;" +
        " color: var(--fill-secondary, #888); font-size: 15px; cursor: pointer;" +
        " border-radius: 4px; line-height: 1; flex-shrink: 0;",
      "×",
    ) as HTMLButtonElement;
    removeBtn.type = "button";
    removeBtn.title = t("Delete level");

    const warning = el(doc, "span", styles.helper + " color: #b45309;");
    warning.style.display = "none";

    const row: ReasoningRow = { wrap, id: idInput, params, warning };
    removeBtn.addEventListener("click", () => {
      reasoningRows = reasoningRows.filter((entry) => entry !== row);
      wrap.remove();
      commit();
    });

    wrap.append(idInput, params, removeBtn, warning);
    reasoningList.append(wrap);
    reasoningRows.push(row);
    return row;
  }

  /** Prefer a suggested slot the user has not taken yet when adding a level. */
  function firstUnusedLevelId(): string {
    const used = new Set(reasoningRows.map((row) => row.id.value.trim()));
    return (
      SUGGESTED_REASONING_LEVEL_IDS.find((levelId) => !used.has(levelId)) || ""
    );
  }

  addLevelBtn.addEventListener("click", () => {
    addReasoningRow();
    commit();
  });

  // ── Extra request parameters ──────────────────────────────────────────────
  const extraWrap = el(
    doc,
    "div",
    "display: flex; flex-direction: column; gap: 4px;",
  );
  const extraInput = el(
    doc,
    "textarea",
    styles.input +
      " min-height: 54px; font-family: monospace; font-size: 12px; resize: vertical;",
  ) as HTMLTextAreaElement;
  extraInput.addEventListener("input", commit);
  const extraError = el(doc, "span", styles.helper + " color: #b45309;");
  extraError.style.display = "none";
  extraWrap.append(
    sectionLabel("Extra request parameters"),
    hint(
      "A JSON object merged into every request to this model, " +
        'for example {"top_k": 40, "options": {"repeat_penalty": 1.1}}.',
    ),
    extraInput,
    extraError,
  );

  // ── Reset ─────────────────────────────────────────────────────────────────
  const resetRow = el(
    doc,
    "div",
    "display: flex; gap: 8px; align-items: center;",
  );
  const resetBtn = el(
    doc,
    "button",
    styles.outlineBtn,
    t("Reset to detected"),
  ) as HTMLButtonElement;
  resetBtn.type = "button";
  resetBtn.addEventListener("click", () => {
    deps.onChange(undefined);
    render();
  });
  // Without this the panel gives no clue whether the rows are what the model
  // reports or what a previous edit left behind — which is exactly how a stale
  // override reads as the truth.
  const customizedBadge = el(
    doc,
    "span",
    "font-size: 10.5px; color: var(--color-accent, #2563eb); font-weight: 600;",
    t("customized for this model"),
  );
  resetRow.append(resetBtn, customizedBadge);

  root.append(capsRow, reasoningWrap, extraWrap, resetRow);

  function commit() {
    if (suspendCommit) return;

    const options: NonNullable<ModelProfileOverride["reasoning"]>["options"] =
      [];
    const seenIds = new Set<string>();
    for (const row of reasoningRows) {
      const id = row.id.value.trim().toLowerCase();
      row.warning.style.display = "none";
      row.warning.textContent = "";
      if (!id) continue;
      if (!LEVEL_ID_PATTERN.test(id)) {
        // Anything outside this shape is dropped by the pref-store validator,
        // so the level would work once and be forgotten on restart.
        row.warning.style.display = "";
        row.warning.textContent = t(
          "Use letters, digits, - or _ so the level is remembered",
        );
        continue;
      }
      if (seenIds.has(id)) {
        row.warning.style.display = "";
        row.warning.textContent = t("Duplicate level — ignored");
        continue;
      }
      const parsed = parseKeyValueField(row.params.value);
      if (parsed.rejected.length) {
        row.warning.style.display = "";
        row.warning.textContent = `${t("Expected key=value: ")}${parsed.rejected.join("; ")}`;
      } else if (
        !Object.keys(parsed.value).length &&
        !SUGGESTED_REASONING_LEVEL_IDS.includes(
          id as (typeof SUGGESTED_REASONING_LEVEL_IDS)[number],
        )
      ) {
        // A level the plugin has no built-in encoding for reaches the provider
        // fallback, which for OpenAI-style profiles returns the *lowest*
        // supported effort — so "ultra" without parameters would quietly mean
        // "minimal". Only warn for ids the plugin cannot already encode.
        row.warning.style.display = "";
        row.warning.textContent = t(
          "Unknown level — add parameters or the provider default is used",
        );
      }
      seenIds.add(id);
      options.push({
        id,
        // Carry the detected label rather than echoing the id. The menu keys
        // its off/on styling off this string — `isReasoningDisplayLabelActive`
        // treats "off" and "disabled" as inactive — so relabelling Ollama's
        // `minimal` to "minimal" would make the button read as *on* while
        // thinking was off.
        label: detectedLabelFor(id) || id,
        enabled: true,
        ...(Object.keys(parsed.value).length
          ? { controls: { body: parsed.value } }
          : {}),
      });
    }

    const features: Record<string, boolean> = {};
    const tools = readTristate(toolsField.select);
    const streaming = readTristate(streamingField.select);
    if (tools !== undefined) features.tools = tools;
    if (streaming !== undefined) features.streaming = streaming;

    const inputs: Record<string, boolean> = {};
    const pdf = readTristate(pdfField.select);
    if (pdf !== undefined) inputs.pdf = pdf;

    const extra = parseJsonObjectField(extraInput.value);
    if (extra.error) {
      extraError.style.display = "";
      extraError.textContent = `${t("Invalid JSON: ")}${extra.error}`;
    } else {
      extraError.style.display = "none";
      extraError.textContent = "";
    }

    // Rows that still match what the model reports are not a customization.
    // Storing them anyway would mark the entry "customized" for doing nothing,
    // and would freeze it against future registry updates for that model.
    const reasoningChanged = !sameOptionSet(
      options,
      detected.reasoning.options,
    );

    deps.onChange(
      pruneProfileOverride({
        ...(options.length && reasoningChanged
          ? { reasoning: { kind: "select" as const, options } }
          : {}),
        ...(Object.keys(inputs).length ? { inputs } : {}),
        ...(Object.keys(features).length ? { features } : {}),
        ...(extra.value && Object.keys(extra.value).length
          ? { extraBody: extra.value }
          : {}),
      }),
    );
  }

  /**
   * Repaint from the stored override, seeding the level list from the detected
   * profile when nothing has been customized yet.
   */
  function render() {
    suspendCommit = true;
    const override = deps.getOverride();

    for (const row of reasoningRows) row.wrap.remove();
    reasoningRows = [];
    const seedSource = override?.reasoning?.options?.length
      ? override.reasoning.options
      : detected.reasoning.options;
    for (const option of seedSource) {
      addReasoningRow({
        id: option.id,
        params: stringifyKeyValueField(option.controls?.body),
      });
    }

    toolsField.select.value = tristateValue(override?.features?.tools);
    streamingField.select.value = tristateValue(override?.features?.streaming);
    pdfField.select.value = tristateValue(override?.inputs?.pdf);

    extraInput.value = override?.extraBody
      ? stringifyJsonObjectField(override.extraBody)
      : "";
    extraInput.placeholder = '{"top_k": 40}';
    extraError.style.display = "none";

    const customized = Boolean(override);
    customizedBadge.style.display = customized ? "" : "none";
    resetBtn.disabled = !customized;
    resetBtn.style.opacity = customized ? "1" : "0.45";
    resetBtn.style.cursor = customized ? "pointer" : "default";

    suspendCommit = false;
  }

  render();

  return {
    element: root,
    refresh: (capabilities: ResolvedModelCapabilities) => {
      detected = capabilities;
      render();
    },
  };
}
