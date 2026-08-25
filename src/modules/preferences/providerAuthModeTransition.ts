import { WEBCHAT_TARGETS } from "../../webchat/types";
import { CODEX_DIRECT_RESPONSES_URL } from "../../codexAuth/auth";
import {
  createCodexDirectModelRow,
  createProviderModelEntry,
  migrateApiBaseForAuthModeChange,
  type CodexDirectProviderGroup,
  type ModelProviderAuthMode,
  type ModelProviderGroup,
  type StandardModelProviderGroup,
} from "../../utils/modelProviders";
import {
  detectProviderPreset,
  getProviderPreset,
} from "../../utils/providerPresets";

export const DEFAULT_COPILOT_API_BASE = "https://api.githubcopilot.com";

function directRows(group: ModelProviderGroup) {
  const rows = group.models.map((row) => ({
    id: row.id,
    model: row.model.trim(),
  }));
  return rows.length ? rows : [createCodexDirectModelRow()];
}

function standardRows(group: ModelProviderGroup) {
  const rows = group.models.map((row) => ({
    ...createProviderModelEntry(row.model),
    id: row.id,
  }));
  return rows.length ? rows : [createProviderModelEntry()];
}

function defaultApiKeyProtocol(group: ModelProviderGroup) {
  if (group.authMode === "codex_auth") return "openai_chat_compat" as const;
  const presetId =
    group.presetIdOverride ?? detectProviderPreset(group.apiBase);
  return presetId === "customized"
    ? "openai_chat_compat"
    : getProviderPreset(presetId).defaultProtocol;
}

export function transitionProviderAuthMode(
  group: ModelProviderGroup,
  nextAuthMode: ModelProviderAuthMode,
): ModelProviderGroup {
  if (nextAuthMode === "codex_auth") {
    const next: CodexDirectProviderGroup = {
      id: group.id,
      apiBase: CODEX_DIRECT_RESPONSES_URL,
      apiKey: "",
      authMode: "codex_auth",
      providerProtocol: "codex_responses",
      models: directRows(group),
    };
    return next;
  }

  const apiBase = migrateApiBaseForAuthModeChange(
    group.authMode,
    nextAuthMode,
    group.apiBase,
  );
  const next: StandardModelProviderGroup = {
    id: group.id,
    apiBase,
    apiKey: group.authMode === "codex_auth" ? "" : group.apiKey,
    authMode: nextAuthMode,
    providerProtocol:
      nextAuthMode === "webchat"
        ? "web_sync"
        : nextAuthMode === "codex_app_server"
          ? "codex_responses"
          : nextAuthMode === "copilot_auth"
            ? "openai_chat_compat"
            : defaultApiKeyProtocol(group),
    models: standardRows(group),
    ...(group.authMode === "codex_auth"
      ? {}
      : { presetIdOverride: group.presetIdOverride }),
  };

  if (nextAuthMode === "webchat") {
    const validModels = new Set<string>(
      WEBCHAT_TARGETS.map((target) => target.modelName),
    );
    const first = next.models[0] || createProviderModelEntry();
    next.models = [
      {
        ...first,
        model: validModels.has(first.model) ? first.model : "chatgpt.com",
      },
    ];
  } else if (nextAuthMode === "copilot_auth" && !next.apiBase.trim()) {
    next.apiBase = DEFAULT_COPILOT_API_BASE;
  }

  return next;
}
