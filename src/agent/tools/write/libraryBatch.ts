import type { AgentToolDefinition } from "../../types";
import type { AgentToolRegistry } from "../registry";
import type { ZoteroGateway } from "../../services/zoteroGateway";
import type { ActionRegistry, ActionServices } from "../../actions";
import { buildActionExecutionContext } from "../../actions/toolContextBridge";
import { getAgentLibraryWriteMode } from "../../libraryWriteMode";
import {
  advanceBatchJob,
  createBatchJob,
  finishBatchJob,
} from "../../store/batchJobStore";
import { ok, fail, validateObject, normalizePositiveInt } from "../shared";

type LibraryBatchInput = {
  job: string;
  jobArgs: Record<string, unknown>;
};

/**
 * Runs a library-wide batch job — the operations that need an LLM decision
 * per item over more items than fit in one context window.
 *
 * The engine already existed and was complete: `src/agent/actions/` does
 * propose → paginate → apply with partial-failure semantics and its own
 * resume. It was a UI feature. Its only two entry points were the chat
 * panel's slash-command controller and the public plugin API, so the model
 * could not name it, and "tag my whole library" was not a request the agent
 * could accept.
 *
 * ## Why this requires `yolo`
 *
 * The runtime's confirmation model is declarative and bracketing: a tool
 * declares a card *before* it runs and a review card *after*. An action wants
 * the opposite — to block mid-execution and ask a question per page — and
 * `requestActionResolution` is a per-turn closure that tool code cannot
 * reach. So a tool call genuinely cannot deliver per-page review.
 *
 * Rather than pretend otherwise, this refuses in `safe` and says where
 * per-page review does live. In `yolo` the model's judgement decides, which
 * is what the mode means — and every page is journalled with its inverse, so
 * the run is reviewable and revertible after the fact rather than during.
 */
/**
 * Jobs that cannot run headlessly, and why.
 *
 * These call `ctx.requestConfirmation` directly — they are interactive review
 * workflows, not batch passes — so the bridged context's throwing stub would
 * fire partway through. Advertising them here and failing mid-run would be
 * worse than not offering them, so they are refused up front with somewhere
 * to go.
 */
const INTERACTIVE_ONLY_JOBS: Record<string, string> = {
  discover_related:
    "discover_related is an interactive review workflow — it presents candidate papers for you to pick from — so it cannot run unattended.",
};

export function createLibraryBatchTool(deps: {
  actionRegistry: ActionRegistry;
  toolRegistry: AgentToolRegistry;
  zoteroGateway: ZoteroGateway;
  services: ActionServices;
  now?: () => number;
}): AgentToolDefinition<LibraryBatchInput, unknown> {
  const now = deps.now ?? (() => Date.now());

  return {
    spec: {
      name: "library_batch",
      description:
        "Run a library-wide batch job that needs a judgement per item across more items than fit in one turn — auto-tagging a whole library, organising items into collections, auditing metadata. Requires the agent library write mode to be 'yolo'; in 'safe' these run from the slash-command surface with per-page review.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["job"],
        properties: {
          job: {
            type: "string",
            description:
              "Which batch job to run. Call with an unknown name to receive the list of available jobs and their arguments.",
          },
          jobArgs: {
            type: "object",
            description:
              "Arguments for the job. Always set an explicit scope — do not rely on a default that means 'the whole library'.",
          },
        },
      },
      mutability: "write",
      requiresConfirmation: true,
    },

    presentation: {
      label: "Library Batch Job",
      summaries: {
        onCall: ({ args }) => {
          const job = (args as { job?: unknown } | undefined)?.job;
          return `Preparing batch job${typeof job === "string" ? `: ${job}` : ""}`;
        },
        onPending: "Waiting for confirmation on a library-wide batch job",
        onApproved: "Running batch job",
        onDenied: "Batch job cancelled",
        onSuccess: ({ content }) => {
          const record =
            content && typeof content === "object"
              ? (content as Record<string, unknown>)
              : {};
          const applied = record.appliedCount;
          return typeof applied === "number"
            ? `Batch job changed ${applied} item${applied === 1 ? "" : "s"}`
            : "Batch job finished";
        },
      },
    },

    validate(args) {
      if (!validateObject<Record<string, unknown>>(args)) {
        return fail(
          'Expected an object. Example: { job: "auto_tag", jobArgs: { scope: "collection", collectionId: 12 } }',
        );
      }
      const job = typeof args.job === "string" ? args.job.trim() : "";
      if (!job) {
        const available = deps.actionRegistry
          .listActions()
          .filter((entry) => !INTERACTIVE_ONLY_JOBS[entry.name])
          .map((entry) => entry.name)
          .join(", ");
        return fail(`job is required. Available jobs: ${available}`);
      }
      const action = deps.actionRegistry.getAction(job);
      if (!action) {
        const available = deps.actionRegistry
          .listActions()
          .filter((entry) => !INTERACTIVE_ONLY_JOBS[entry.name])
          .map((entry) => `${entry.name} — ${entry.description}`)
          .join("; ");
        return fail(`Unknown job "${job}". Available: ${available}`);
      }
      const interactiveReason = INTERACTIVE_ONLY_JOBS[job];
      if (interactiveReason) {
        return fail(
          `${interactiveReason} Run it from the chat surface with /${job} instead.`,
        );
      }
      const jobArgs = validateObject<Record<string, unknown>>(args.jobArgs)
        ? args.jobArgs
        : {};
      return ok({ job, jobArgs });
    },

    createPendingAction(input, context) {
      const action = deps.actionRegistry.getAction(input.job);
      const scope =
        typeof input.jobArgs.scope === "string"
          ? input.jobArgs.scope
          : "the current selection";
      const limit = normalizePositiveInt(input.jobArgs.limit);
      return {
        toolName: "library_batch",
        title: `Run "${input.job}" across your library`,
        description:
          `${action?.description || input.job}\n\n` +
          `Scope: ${scope}${limit ? `, up to ${limit} items` : ""}. ` +
          "This runs unattended and can change many items at once. The whole run is recorded and can be reverted from the agent history.",
        confirmLabel: "Run job",
        cancelLabel: "Cancel",
        fields: [
          {
            type: "text" as const,
            id: "job",
            label: "Job",
            value: input.job,
          },
          {
            type: "code_preview" as const,
            id: "jobArgs",
            label: "Arguments",
            value: JSON.stringify(input.jobArgs, null, 2),
            language: "json",
          },
        ],
      };
      void context;
    },

    applyConfirmation(input) {
      // Read-only card: approving means "run exactly this".
      return ok(input);
    },

    async execute(input, context) {
      const mode = getAgentLibraryWriteMode();
      if (mode !== "yolo") {
        // Refuse rather than silently degrade. A tool call cannot deliver
        // per-page review, and running unattended under a mode named "safe"
        // would be exactly the surprise the mode exists to prevent.
        throw new Error(
          `Library batch jobs run unattended, so they require the agent library write mode to be "yolo" (currently "${mode}"). Either change it in the plugin preferences, or run this from the chat surface with /${input.job}, which reviews each page before applying it.`,
        );
      }

      const action = deps.actionRegistry.getAction(input.job);
      if (!action) {
        throw new Error(`Unknown batch job "${input.job}"`);
      }

      const jobId = `batch-${input.job}-${now()}`;
      const startedAt = now();
      await createBatchJob({
        jobId,
        conversationKey: context.request.conversationKey,
        action: input.job,
        input: input.jobArgs,
        now: startedAt,
      });

      const progress: string[] = [];
      const actionContext = buildActionExecutionContext({
        context,
        registry: deps.toolRegistry,
        zoteroGateway: deps.zoteroGateway,
        services: deps.services,
        // The model's judgement decides. Inner tool confirmations
        // self-approve; the run is journalled instead of interrogated.
        confirmationMode: "auto_approve",
        // Groups every page's changes under this job so the whole run
        // reverts as a unit.
        runId: jobId,
        onProgress: (event) => {
          if (event.type === "step_done" && event.summary) {
            progress.push(event.summary);
          }
        },
      });

      try {
        const result = await action.execute(input.jobArgs, actionContext);
        const output =
          result.ok && result.output && typeof result.output === "object"
            ? (result.output as Record<string, unknown>)
            : {};
        // Each action names its own outcome field. Probing a fixed list
        // meant audit_library (metadataFixed) reported zero changes having
        // fixed many, so unknown shapes fall back to the largest reported
        // count rather than silently to 0.
        const appliedCount =
          readCount(output.moved) ??
          readCount(output.tagged) ??
          readCount(output.updated) ??
          readCount(output.metadataFixed) ??
          readCount(output.imported) ??
          largestCount(output) ??
          0;

        await advanceBatchJob({
          jobId,
          cursor: readCount(output.processed) ?? appliedCount,
          appliedCount,
          now: now(),
        });
        await finishBatchJob({
          jobId,
          status: result.ok ? "completed" : "failed",
          now: now(),
        });

        if (!result.ok) {
          throw new Error(result.error || `Batch job "${input.job}" failed`);
        }

        return {
          job: input.job,
          jobId,
          appliedCount,
          // Everything the action reported, so the model can state real
          // numbers rather than "done".
          output,
          progress: progress.slice(-20),
        };
      } catch (error) {
        await finishBatchJob({ jobId, status: "failed", now: now() });
        throw error;
      }
    },
  };
}

/**
 * The largest numeric field an action reported, used when none of the known
 * outcome names are present. `processed` is excluded because it counts items
 * *considered*, not items changed, and reporting it as "applied" would
 * overstate the run.
 */
function largestCount(output: Record<string, unknown>): number | undefined {
  const counts = Object.entries(output)
    .filter(([key]) => key !== "processed" && key !== "remaining")
    .map(([, value]) => readCount(value))
    .filter((value): value is number => value !== undefined);
  return counts.length ? Math.max(...counts) : undefined;
}

function readCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}
