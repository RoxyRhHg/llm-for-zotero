import { assert } from "chai";
import {
  ActionContractService,
  extractLibraryMutationOperations,
} from "../src/agent/contracts/actionContract";
import { evaluateActionContract } from "../src/agent/contracts/actionEvaluation";
import {
  inferActionIntentsFromRequest,
  parseClassifiedTurnIntent,
} from "../src/agent/model/skillClassifier";
import type {
  AgentActionContract,
  AgentRuntimeRequest,
  AgentToolDefinition,
} from "../src/agent/types";

type FakeItemState = {
  tags: string[];
  collections: number[];
  fields: Record<string, string>;
  deleted?: boolean;
  noteHtml?: string;
  parentItemId?: number | null;
};

function createHarness() {
  const directMembers = new Map<number, number[]>([
    [10, [90]],
    [11, [1, 2, 3]],
    [12, [50, 51]],
  ]);
  const items = new Map<number, FakeItemState>();
  const summaries = [
    { collectionId: 10, libraryID: 1, name: "Parent", path: "Parent" },
    {
      collectionId: 11,
      libraryID: 1,
      name: "Leaf",
      path: "Parent/Leaf",
    },
    {
      collectionId: 12,
      libraryID: 1,
      name: "Sibling",
      path: "Parent/Sibling",
    },
  ];
  const gateway = {
    getCollectionSummary(collectionId: number) {
      return (
        summaries.find((summary) => summary.collectionId === collectionId) ||
        null
      );
    },
    listCollectionSummaries(libraryID: number) {
      return summaries.filter((summary) => summary.libraryID === libraryID);
    },
    listCurrentCollectionSummaries(libraryID: number) {
      return summaries.filter((summary) => summary.libraryID === libraryID);
    },
    listCurrentCollectionTargetIds(params: { collectionId: number }) {
      return [...(directMembers.get(params.collectionId) || [])];
    },
    async listCollectionPaperTargets(params: { collectionId: number }) {
      return {
        papers: (directMembers.get(params.collectionId) || []).map(
          (itemId) => ({
            itemId,
          }),
        ),
      };
    },
    async listCollectionItemTargets(params: { collectionId: number }) {
      return {
        items: (directMembers.get(params.collectionId) || []).map((itemId) => ({
          itemId,
        })),
      };
    },
    getItem(itemId: number) {
      const state = items.get(itemId);
      if (!state) return null;
      return {
        id: itemId,
        parentID: state.parentItemId || false,
        deleted: state.deleted,
        isNote: () => state.noteHtml !== undefined,
        getNote: () => state.noteHtml || "",
        getTags: () => state.tags.map((tag) => ({ tag })),
        getCollections: () => state.collections,
      } as unknown as Zotero.Item;
    },
    getEditableArticleMetadata(item: Zotero.Item | null | undefined) {
      if (!item) return null;
      const state = [...items.values()].find(
        (candidate) => candidate.collections === item.getCollections(),
      );
      return state ? { fields: state.fields, creators: [] } : null;
    },
  };
  return {
    directMembers,
    gateway,
    items,
    service: new ActionContractService(gateway),
  };
}

function scopedRequest(): AgentRuntimeRequest {
  return {
    conversationKey: 1,
    mode: "agent",
    userText: "Tag every paper in the selected collection",
    model: "test",
    selectedCollectionContexts: [
      { collectionId: 11, libraryID: 1, name: "Leaf" },
    ],
    classifiedIntent: {
      retrievalIntent: "none",
      wantedSections: [],
      actionIntents: [
        {
          capability: "zotero.tags",
          coverage: "all",
          targetKind: "papers",
          scope: { kind: "collection", includeDescendants: false },
        },
      ],
    },
  };
}

function semanticTool(): AgentToolDefinition<any, unknown> {
  return {
    spec: {
      name: "library_update",
      description: "test",
      inputSchema: { type: "object" },
      mutability: "write",
      requiresConfirmation: true,
    },
    describeAction: () => ({
      kind: "semantic_state",
      capability: "zotero.read",
      source: "library_mutation",
    }),
    validate: (input) => ({ ok: true, value: input }),
    execute: async () => ({ content: {}, effect: "applied" }),
  };
}

describe("systematic agent action contracts", function () {
  it("resolves a newly created named collection from current Zotero state rather than a stale search snapshot", async function () {
    const { gateway, service } = createHarness();
    gateway.listCollectionSummaries = () => [];
    gateway.listCollectionItemTargets = async () => ({ items: [] });
    const request = scopedRequest();
    request.selectedCollectionContexts = [];
    request.libraryID = 1;
    request.classifiedIntent!.actionIntents[0].scope = {
      kind: "collection",
      path: "Parent/Leaf",
      includeDescendants: false,
    };

    const contract = await service.createContract(request);

    assert.equal(contract?.obligations[0].scope?.collectionId, 11);
    assert.deepEqual(
      contract?.obligations[0].scope?.frozenTargetIds,
      [1, 2, 3],
    );
  });

  it("freezes exact direct membership and rejects parent, sibling, and partial targets", async function () {
    const { service } = createHarness();
    const contract = await service.createContract(scopedRequest());
    assert.deepEqual(
      contract?.obligations[0].scope?.frozenTargetIds,
      [1, 2, 3],
    );

    const exact = await service.prepare(semanticTool(), {
      operation: { type: "apply_tags", itemIds: [1, 2, 3], tags: ["topic"] },
    });
    assert.isNull(await service.validateScope(contract!, exact));

    const widened = await service.prepare(semanticTool(), {
      operation: {
        type: "apply_tags",
        itemIds: [1, 2, 3, 50, 90],
        tags: ["topic"],
      },
    });
    const widenedFailure = await service.validateScope(contract!, widened);
    assert.deepEqual(widenedFailure?.rejectedTargets, ["item:50", "item:90"]);
    assert.equal(widenedFailure?.expectedCount, 3);
    assert.equal(widenedFailure?.proposedCount, 5);

    const partial = await service.prepare(semanticTool(), {
      operation: { type: "apply_tags", itemIds: [1, 2], tags: ["topic"] },
    });
    assert.deepEqual(
      (await service.validateScope(contract!, partial))?.missingTargets,
      ["item:3"],
    );
  });

  it("turns membership drift between planning and execution into a retryable refusal", async function () {
    const { service, directMembers } = createHarness();
    const contract = await service.createContract(scopedRequest());
    directMembers.set(11, [1, 2, 3, 4]);
    const prepared = await service.prepare(semanticTool(), {
      operation: { type: "apply_tags", itemIds: [1, 2, 3], tags: ["topic"] },
    });
    const failure = await service.validateScope(contract!, prepared);
    assert.include(failure?.message || "", "changed after planning");
    assert.equal(failure?.expectedCount, 3);
  });

  it("allows itemless setup operations without satisfying scoped item coverage", async function () {
    const { service } = createHarness();
    const request = scopedRequest();
    request.classifiedIntent!.actionIntents[0].capability =
      "zotero.collections";
    const contract = (await service.createContract(request))!;
    const prepared = await service.prepare(semanticTool(), {
      operation: { type: "create_collection", name: "Destination" },
    });

    assert.isNull(await service.validateScope(contract, prepared));
    const receipt = service.finalize(prepared, {
      ok: true,
      effect: "applied",
      content: { result: { collectionId: 20 } },
    });
    assert.equal(evaluateActionContract(contract, [receipt]).state, "pending");
  });

  it("includes descendants only when the contract explicitly requests them", async function () {
    const { service } = createHarness();
    const request = scopedRequest();
    request.selectedCollectionContexts = [
      { collectionId: 10, libraryID: 1, name: "Parent" },
    ];
    request.classifiedIntent!.actionIntents[0].scope!.includeDescendants = true;
    const contract = await service.createContract(request);
    assert.deepEqual(
      [...(contract?.obligations[0].scope?.frozenTargetIds || [])].sort(
        (left, right) => left - right,
      ),
      [1, 2, 3, 50, 51, 90],
    );
  });

  it("validates exact destination collections and tag-prefix constraints", async function () {
    const { service } = createHarness();
    const noteRequest = scopedRequest();
    noteRequest.classifiedIntent!.actionIntents = [
      {
        capability: "zotero.notes",
        coverage: "one",
        targetKind: "items",
        scopeRole: "destination",
        scope: { kind: "collection", includeDescendants: false },
      },
    ];
    const noteContract = await service.createContract(noteRequest);
    const wrongDestination = await service.prepare(semanticTool(), {
      operation: {
        type: "save_note",
        target: "standalone",
        content: "note",
        collections: [12],
      },
    });
    assert.deepEqual(
      (await service.validateScope(noteContract!, wrongDestination))
        ?.rejectedTargets,
      ["collection:12"],
    );

    const tagRequest = scopedRequest();
    tagRequest.classifiedIntent!.actionIntents[0].constraints = {
      tagPrefix: "topic:",
    };
    const tagContract = await service.createContract(tagRequest);
    const invalidTag = await service.prepare(semanticTool(), {
      operation: {
        type: "apply_tags",
        itemIds: [1, 2, 3],
        tags: ["topic:methods", "unprefixed"],
      },
    });
    assert.deepEqual(
      (await service.validateScope(tagContract!, invalidTag))?.rejectedTargets,
      ["tag:unprefixed"],
    );
  });

  it("requires atomic source removal and exact destination membership for a true move", async function () {
    const { service } = createHarness();
    const request = scopedRequest();
    request.selectedCollectionContexts = [];
    request.libraryID = 1;
    request.userText =
      'Move the paper titled "Target" out of the collection "Parent/Leaf" and into "Parent/Sibling".';
    request.classifiedIntent!.actionIntents =
      inferActionIntentsFromRequest(request);
    const contract = await service.createContract(request);

    const addOnly = await service.prepare(semanticTool(), {
      operation: {
        type: "move_to_collection",
        itemIds: [1],
        targetCollectionId: 12,
        mode: "add",
      },
    });
    assert.include(
      (await service.validateScope(contract!, addOnly))?.message || "",
      "True move required",
    );

    const trueMove = await service.prepare(semanticTool(), {
      operation: {
        type: "move_to_collection",
        itemIds: [1],
        targetCollectionId: 12,
        mode: "move",
        from: 11,
      },
    });
    assert.isNull(await service.validateScope(contract!, trueMove));
  });

  it("counts already-satisfied targets toward complete verified coverage", async function () {
    const { service, items } = createHarness();
    items.set(1, { tags: [], collections: [11], fields: {} });
    items.set(2, { tags: ["topic"], collections: [11], fields: {} });
    items.set(3, { tags: [], collections: [11], fields: {} });
    const contract = (await service.createContract(scopedRequest()))!;
    const prepared = await service.prepare(semanticTool(), {
      operation: {
        type: "apply_tags",
        itemIds: [1, 2, 3],
        tags: ["topic"],
      },
    });
    items.get(1)!.tags = ["topic"];
    items.get(3)!.tags = ["topic"];
    const receipt = service.finalize(prepared, {
      ok: true,
      effect: "partial",
    });
    assert.deepEqual(receipt.appliedTargets, ["item:1", "item:3"]);
    assert.deepEqual(receipt.alreadySatisfiedTargets, ["item:2"]);
    assert.equal(receipt.verification, "verified");
    assert.equal(
      evaluateActionContract(contract, [receipt]).state,
      "satisfied",
    );
  });

  it("verifies standalone note creation from the note tool's actual result and Zotero state", async function () {
    const { service, items } = createHarness();
    const request = scopedRequest();
    request.classifiedIntent!.actionIntents = [
      {
        capability: "zotero.notes",
        coverage: "one",
        targetKind: "items",
        scopeRole: "destination",
        scope: { kind: "collection", includeDescendants: false },
      },
    ];
    const contract = (await service.createContract(request))!;
    const tool: AgentToolDefinition<any, unknown> = {
      ...semanticTool(),
      describeAction: (input) => ({
        kind: "semantic_state",
        capability: "zotero.notes",
        source: "library_mutation",
        action: {
          kind: "note_write",
          mode: input.mode,
          destinationCollectionIds: input.collections,
          expectedText: input.content,
        },
      }),
    };
    const prepared = await service.prepare(tool, {
      mode: "create",
      target: "standalone",
      collections: [11],
      content: "Issue388 note",
    });
    assert.isNull(await service.validateScope(contract, prepared));
    items.set(42, {
      tags: [],
      collections: [11],
      fields: {},
      noteHtml: "<p>Issue388 note</p>",
    });
    const receipt = service.finalize(prepared, {
      ok: true,
      effect: "applied",
      content: {
        result: {
          operation: "save_note",
          result: { status: "created", noteId: 42 },
        },
      },
    });
    assert.equal(receipt.capability, "zotero.notes");
    assert.equal(receipt.verification, "verified");
    assert.deepEqual(receipt.appliedTargets, ["item:42"]);
    assert.equal(
      evaluateActionContract(contract, [receipt]).state,
      "satisfied",
    );
  });

  it("verifies rendered Zotero note text against Markdown-structured input", async function () {
    const { service, items } = createHarness();
    const tool: AgentToolDefinition<any, unknown> = {
      ...semanticTool(),
      describeAction: () => ({
        kind: "semantic_state",
        capability: "zotero.notes",
        source: "library_mutation",
        action: {
          kind: "note_write",
          mode: "create",
          destinationCollectionIds: [11],
          expectedText: "# Issue388-note-flash\n\n**Issue388-note-flash**",
        },
      }),
    };
    const prepared = await service.prepare(tool, {});
    items.set(43, {
      tags: [],
      collections: [11],
      fields: {},
      noteHtml:
        "<p>Model response: deepseek-v4-flash</p><h1>Issue388-note-flash</h1><p><strong>Issue388-note-flash</strong></p><hr/><p>Written by LLM-for-Zotero.</p>",
    });
    const receipt = service.finalize(prepared, {
      ok: true,
      effect: "applied",
      content: {
        operation: "save_note",
        result: { status: "standalone_created", noteId: 43 },
      },
    });
    assert.equal(receipt.status, "applied");
    assert.equal(receipt.verification, "verified");
    assert.deepEqual(receipt.appliedTargets, ["item:43"]);
  });

  it("verifies note edits against the addressed note's stored content", async function () {
    const { service, items } = createHarness();
    items.set(42, {
      tags: [],
      collections: [11],
      fields: {},
      noteHtml: "<p>Edited note</p>",
    });
    const prepared = await service.prepare(
      {
        ...semanticTool(),
        describeAction: () => ({
          kind: "semantic_state",
          capability: "zotero.notes",
          source: "library_mutation",
          action: {
            kind: "note_write",
            mode: "edit",
            targetNoteId: 42,
            destinationCollectionIds: [],
            expectedText: "Edited note",
          },
        }),
      },
      { mode: "edit", targetNoteId: 42, content: "Edited note" },
    );
    const receipt = service.finalize(prepared, {
      ok: true,
      effect: "applied",
      content: { status: "updated", noteId: 42 },
    });
    assert.equal(receipt.verification, "verified");
    assert.deepEqual(receipt.requestedTargets, ["item:42"]);
  });

  it("keeps artifact and execution-only proof levels distinct", async function () {
    const { service } = createHarness();
    const file = await service.prepare(
      {
        ...semanticTool(),
        spec: { ...semanticTool().spec, name: "file_io" },
        describeAction: () => ({
          kind: "artifact_state",
          capability: "file.write",
        }),
      },
      { filePath: "/tmp/example.md" },
    );
    const fileReceipt = service.finalize(file, { ok: true, effect: "applied" });
    assert.equal(fileReceipt.verification, "verified");
    assert.deepEqual(fileReceipt.appliedTargets, ["file:/tmp/example.md"]);

    const command = await service.prepare(
      {
        ...semanticTool(),
        spec: { ...semanticTool().spec, name: "run_command" },
        describeAction: () => ({
          kind: "execution_only",
          capability: "command.execute",
        }),
      },
      { command: "true" },
    );
    const commandReceipt = service.finalize(command, {
      ok: true,
      effect: "applied",
    });
    assert.equal(commandReceipt.verification, "execution_only");
    assert.equal(commandReceipt.status, "observed");
    assert.deepEqual(commandReceipt.appliedTargets, []);

    const cancelled = service.finalize(file, {
      ok: false,
      cancelled: true,
      reason: "User denied action",
    });
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.verification, "verified");
  });

  it("rejects an unrelated execution-only escape from a semantic action contract", async function () {
    const { service } = createHarness();
    const contract = await service.createContract(scopedRequest());
    const command = await service.prepare(
      {
        ...semanticTool(),
        spec: { ...semanticTool().spec, name: "run_command" },
        describeAction: () => ({
          kind: "execution_only",
          capability: "command.execute",
        }),
      },
      { command: "echo bypass" },
    );

    const rejection = await service.validateScope(
      contract || undefined,
      command,
    );

    assert.include(rejection?.message || "", "outside this action contract");
    assert.deepEqual(rejection?.missingTargets, ["zotero.tags"]);
  });

  it("extracts nested facade operations and assigns action capabilities", async function () {
    const { service } = createHarness();
    const cases = [
      [
        { type: "update_metadata", itemId: 1, metadata: { title: "T" } },
        "zotero.metadata",
      ],
      [
        { type: "move_to_collection", itemIds: [1], targetCollectionId: 12 },
        "zotero.collections",
      ],
      [
        {
          type: "save_notes_batch",
          notes: [{ targetItemId: 1, content: "N" }],
        },
        "zotero.notes",
      ],
      [{ type: "trash_items", itemIds: [1] }, "zotero.trash"],
      [{ type: "delete_attachment", attachmentId: 1 }, "zotero.attachments"],
    ] as const;
    for (const [operation, capability] of cases) {
      const input = { delegateInput: { operation } };
      assert.lengthOf(extractLibraryMutationOperations(input), 1);
      assert.equal(
        (await service.prepare(semanticTool(), input)).capability,
        capability,
      );
    }
  });

  it("reports an omitted obligation as pending instead of accepting prose", function () {
    const contract: AgentActionContract = {
      version: 1,
      state: "pending",
      correctionCount: 0,
      obligations: [
        {
          id: "zotero.tags:unscoped",
          capability: "zotero.tags",
          coverage: "some",
          targetKind: "papers",
        },
      ],
    };
    const evaluation = evaluateActionContract(contract, []);
    assert.equal(evaluation.state, "pending");
    assert.include(evaluation.correction || "", "verified receipt");
    assert.include(evaluation.correction || "", "library_update");
    assert.include(evaluation.failure || "", "zotero.tags");
  });

  it("keeps a verified success satisfied when a later redundant call is cancelled", function () {
    const contract: AgentActionContract = {
      version: 1,
      state: "pending",
      correctionCount: 0,
      obligations: [
        {
          id: "zotero.tags:unscoped",
          capability: "zotero.tags",
          coverage: "one",
          targetKind: "papers",
        },
      ],
    };
    const receipt = {
      version: 1 as const,
      descriptorKind: "semantic_state" as const,
      capability: "zotero.tags" as const,
      verification: "verified" as const,
      status: "applied" as const,
      requestedTargets: ["item:1"],
      appliedTargets: ["item:1"],
      alreadySatisfiedTargets: [],
      rejectedTargets: [],
      reasons: [],
      verifiedFacts: [],
    };
    const cancelled = {
      ...receipt,
      status: "cancelled" as const,
      appliedTargets: [],
      reasons: ["User denied redundant action"],
    };

    assert.equal(
      evaluateActionContract(contract, [receipt, cancelled]).state,
      "satisfied",
    );
    assert.equal(
      evaluateActionContract(contract, [cancelled]).state,
      "cancelled",
    );
  });

  it("parses action intents and lets selected leaf context override a model-expanded parent", function () {
    const parsed = parseClassifiedTurnIntent(
      JSON.stringify({
        retrievalIntent: "none",
        wantedSections: [],
        actionIntents: [
          {
            capability: "zotero.tags",
            coverage: "all",
            targetKind: "papers",
            scope: {
              kind: "collection",
              path: "Parent",
              includeDescendants: true,
            },
          },
        ],
      }),
    );
    assert.equal(parsed?.actionIntents[0].scope?.path, "Parent");
    const inferred = inferActionIntentsFromRequest({
      userText: 'Tag every paper in collection "Parent"',
      selectedCollectionContexts: [
        { collectionId: 11, libraryID: 1, name: "Leaf" },
      ],
    });
    assert.equal(inferred[0].scope?.path, undefined);
    assert.isFalse(inferred[0].scope?.includeDescendants);
  });

  it("keeps long named-item operations under deterministic action enforcement", function () {
    const move = inferActionIntentsFromRequest({
      userText:
        'Move the paper titled "MoveSubject-with-a-title-long-enough-to-defeat-windowed-regex-matching" out of the collection "MoveFrom" and into "MoveTo". It should end up only in the destination.',
    });
    assert.deepInclude(move, {
      capability: "zotero.collections",
      coverage: "one",
      targetKind: "items",
      scopeRole: "source",
      scope: {
        kind: "collection",
        path: "MoveFrom",
        includeDescendants: false,
      },
      constraints: { collectionMode: "move" },
    });
    assert.deepInclude(move, {
      capability: "zotero.collections",
      coverage: "one",
      targetKind: "items",
      scopeRole: "destination",
      scope: {
        kind: "collection",
        path: "MoveTo",
        includeDescendants: false,
      },
      constraints: { collectionMode: "move" },
    });

    const metadata = inferActionIntentsFromRequest({
      userText:
        'Set the Extra field on the paper titled "A similarly long paper title that separates the verb from its field name" to "verified".',
    });
    assert.equal(metadata[0]?.capability, "zotero.metadata");
    assert.equal(metadata[0]?.coverage, "one");

    const collection = inferActionIntentsFromRequest({
      userText: 'Create a new collection called "Action Contract Target".',
    });
    assert.equal(collection[0]?.capability, "zotero.collections");

    const tagsOnly = inferActionIntentsFromRequest({
      userText:
        'Look at papers whose title contains "Acc3". Decide on exactly 3 topic tags that describe this set, then tag every paper. Use the same 3 tags across the whole set.',
    });
    assert.deepEqual(
      tagsOnly.map((intent) => intent.capability),
      ["zotero.tags"],
    );

    const importIntoNewCollection = inferActionIntentsFromRequest({
      userText:
        'Search the literature online, then import the 3 most relevant papers into a new Zotero collection called "Future Collection".',
    });
    assert.sameMembers(
      importIntoNewCollection.map((intent) => intent.capability),
      ["zotero.collections", "zotero.import"],
    );
    assert.isTrue(
      importIntoNewCollection.every((intent) => intent.scope === undefined),
    );
  });
});
