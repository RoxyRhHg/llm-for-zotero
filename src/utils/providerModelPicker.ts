/**
 * Decision logic for the preferences model dropdown (fetch & select).
 *
 * The preferences pane owns the DOM; everything that can be decided without a
 * document lives here so the dropdown behaves identically under unit tests
 * and in the Gecko preferences window.
 */

import type { DiscoveredModel } from "../modelCapabilities";
import type { ModelProviderGroup } from "./modelProviders";
import { detectProviderPreset } from "./providerPresets";
import type { ProviderPresetId } from "./providerPresets";

export type ProviderModelPickerGroup = Pick<
  ModelProviderGroup,
  "authMode" | "apiBase"
> &
  Partial<Pick<ModelProviderGroup, "presetIdOverride">>;

/**
 * Preset the picker should treat the group as. Non-API-key auth modes (codex,
 * copilot, webchat) keep their dedicated model flows, so they resolve to
 * "customized" here regardless of the stored API base.
 */
export function resolveProviderPickerPresetId(
  group: ProviderModelPickerGroup,
): ProviderPresetId {
  if (group.authMode !== "api_key") return "customized";
  return group.presetIdOverride ?? detectProviderPreset(group.apiBase);
}

/** Fetch-and-select is offered only for preset (non-customized) API-key providers. */
export function canFetchProviderModels(
  group: ProviderModelPickerGroup,
): boolean {
  return resolveProviderPickerPresetId(group) !== "customized";
}

export function sortModelOptions(models: DiscoveredModel[]): DiscoveredModel[] {
  return [...models].sort((left, right) =>
    left.id.localeCompare(right.id, undefined, { sensitivity: "base" }),
  );
}

/**
 * Sentinel `<option>` value for the "Customized…" row. Choosing it reveals
 * the manual text input instead of writing a model name.
 */
export const CUSTOMIZED_MODEL_OPTION_VALUE = "__llm-for-zotero-customized__";

export type ProviderModelSelectRow =
  | { kind: "placeholder" }
  | { kind: "model"; id: string; fromCatalog: boolean }
  | { kind: "customized" };

/**
 * Rows for the model `<select>`: the sorted live catalog, plus a saved model
 * the catalog does not know (so an existing configuration never disappears),
 * plus the trailing "Customized…" row. While the manual input is active the
 * saved text lives in that input, so it is not duplicated as an option.
 */
export function buildProviderModelSelectRows(args: {
  savedModel: string;
  catalog: DiscoveredModel[];
  customizedActive: boolean;
}): ProviderModelSelectRow[] {
  const saved = args.savedModel.trim();
  const sorted = sortModelOptions(args.catalog);
  const rows: ProviderModelSelectRow[] = [];
  if (!saved && !args.customizedActive) rows.push({ kind: "placeholder" });
  if (
    saved &&
    !args.customizedActive &&
    !sorted.some((model) => model.id === saved)
  ) {
    rows.push({ kind: "model", id: saved, fromCatalog: false });
  }
  for (const model of sorted) {
    rows.push({ kind: "model", id: model.id, fromCatalog: true });
  }
  rows.push({ kind: "customized" });
  return rows;
}

export type ProviderModelFetchStatus =
  | { kind: "needs_api_key" }
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; total: number; stale: boolean };

/** Status line shown under the model row while the catalog loads or fails. */
export function resolveProviderModelFetchStatus(args: {
  apiKey: string;
  loading: boolean;
  snapshot: { models: DiscoveredModel[]; error?: string } | null;
}): ProviderModelFetchStatus {
  if (!args.apiKey.trim()) return { kind: "needs_api_key" };
  const models = args.snapshot?.models || [];
  if (!models.length) {
    if (args.loading || !args.snapshot) return { kind: "loading" };
    return args.snapshot.error
      ? { kind: "error", message: args.snapshot.error }
      : { kind: "ready", total: 0, stale: false };
  }
  return {
    kind: "ready",
    total: models.length,
    stale: Boolean(args.snapshot?.error),
  };
}
