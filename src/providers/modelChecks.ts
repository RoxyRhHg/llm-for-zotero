/**
 * Cross-cutting model restriction check.
 *
 * Returns true for models that are text-only and cannot process images,
 * PDFs, or any non-text content regardless of which provider tier they
 * belong to.
 */
function getModelNameCandidates(model: string): string[] {
  const normalized = model.trim().toLowerCase();
  if (!normalized) return [];
  const tail = normalized.split("/").pop() || "";
  return tail && tail !== normalized ? [normalized, tail] : [normalized];
}

function isDeepseekModel(candidate: string): boolean {
  return /^deepseek(?:$|[-.])/.test(candidate);
}

function isExplicitTextOnlyModel(candidate: string): boolean {
  return /text-only|embedding/.test(candidate);
}

export function isTextOnlyModel(model: string): boolean {
  const candidates = getModelNameCandidates(model);
  const deepseekCandidates = candidates.filter(isDeepseekModel);
  if (deepseekCandidates.length) {
    // DeepSeek model families can contain both text-only and vision variants,
    // so model-name prefixes are not a safe capability boundary. Users can
    // still select the explicit text-only input mode for models that need it.
    return deepseekCandidates.some(isExplicitTextOnlyModel);
  }
  return candidates.some(
    (candidate) =>
      /reasoner/.test(candidate) || isExplicitTextOnlyModel(candidate),
  );
}
