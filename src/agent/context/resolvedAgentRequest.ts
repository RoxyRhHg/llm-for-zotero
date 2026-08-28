import type {
  AgentRuntimeRequestInput,
  ResolvedAgentRuntimeRequest,
} from "../types";
import {
  buildTurnPaperScope,
  type TurnPaperScopeBuildResult,
} from "./turnPaperScope";
import type { PaperContextRef } from "../../shared/types";

export type AgentRequestPaperContextResolver = (selector: {
  itemId?: number;
  contextItemId?: number;
}) => PaperContextRef | null;

export class InvalidTurnPaperScopeError extends Error {
  constructor(
    readonly result: Extract<TurnPaperScopeBuildResult, { ok: false }>,
  ) {
    super(result.message);
    this.name = "InvalidTurnPaperScopeError";
  }
}

/**
 * One-way runtime boundary from UI/persisted compatibility fields to the
 * canonical per-turn paper scope.
 */
export function resolveAgentRuntimeRequest(
  input: AgentRuntimeRequestInput,
  options: { resolvePaperContext?: AgentRequestPaperContextResolver } = {},
): ResolvedAgentRuntimeRequest {
  const scopeResult = buildTurnPaperScope({
    libraryID: input.libraryID,
    conversationKind: input.conversationKind,
    activeItemId: input.activeItemId,
    selectedPaperContexts: input.selectedPaperContexts,
    pdfPaperContexts: input.pdfPaperContexts,
    fullTextPaperContexts: input.fullTextPaperContexts,
    pinnedPaperContexts: input.pinnedPaperContexts,
    selectedCollectionContexts: input.selectedCollectionContexts,
    selectedTagContexts: input.selectedTagContexts,
    selectedTextContexts: input.selectedTextContexts,
    selectedTexts: input.selectedTexts,
    selectedTextSources: input.selectedTextSources,
    selectedTextNoteContexts: input.selectedTextNoteContexts,
    selectedTextPaperContexts: input.selectedTextPaperContexts,
    resolvedSelectedTextAnchors: input.resolvedSelectedTextAnchors,
    localDocuments: input.localDocuments,
    resolvePaperContext: options.resolvePaperContext,
  });
  if (!scopeResult.ok) throw new InvalidTurnPaperScopeError(scopeResult);

  const {
    selectedPaperContexts: _selectedPaperContexts,
    pdfPaperContexts: _pdfPaperContexts,
    fullTextPaperContexts: _fullTextPaperContexts,
    citationPaperContexts: _citationPaperContexts,
    pinnedPaperContexts: _pinnedPaperContexts,
    selectedCollectionContexts: _selectedCollectionContexts,
    selectedTagContexts: _selectedTagContexts,
    selectedTextPaperContexts: _selectedTextPaperContexts,
    selectedTextContexts: _selectedTextContexts,
    resolvedSelectedTextAnchors: _resolvedSelectedTextAnchors,
    localDocuments: _localDocuments,
    ...rest
  } = input;
  void _selectedPaperContexts;
  void _pdfPaperContexts;
  void _fullTextPaperContexts;
  void _citationPaperContexts;
  void _pinnedPaperContexts;
  void _selectedCollectionContexts;
  void _selectedTagContexts;
  void _selectedTextPaperContexts;
  void _selectedTextContexts;
  void _resolvedSelectedTextAnchors;
  void _localDocuments;

  return {
    ...rest,
    turnPaperScope: scopeResult.scope,
    selectedTextContexts: scopeResult.selectedTextContexts.length
      ? scopeResult.selectedTextContexts
      : undefined,
    resolvedSelectedTextAnchors: scopeResult.resolvedSelectedTextAnchors.length
      ? scopeResult.resolvedSelectedTextAnchors
      : undefined,
    localDocuments: scopeResult.localDocuments.length
      ? scopeResult.localDocuments
      : undefined,
    turnPaperScopeWarnings: scopeResult.warnings.length
      ? scopeResult.warnings
      : undefined,
  };
}
