import type { SendQuestionOptions } from "./types";
import type { InputCapEffects } from "../../utils/modelInputCap";
import type { ContextAssemblyStrategy, MultiContextPlan } from "./types";

export type WorkflowTestSendInterceptor = (
  opts: SendQuestionOptions,
) => Promise<boolean | void> | boolean | void;

export type WorkflowTestFinalRequestSnapshot = {
  prompt: string;
  historyTexts: string[];
  combinedContext: string;
  strategy: ContextAssemblyStrategy;
  systemMessages: string[];
  inputCapEffects: InputCapEffects;
  readStrategy?: MultiContextPlan["readStrategy"];
  coverageReceipt?: MultiContextPlan["coverageReceipt"];
  fullReadReceipt?: MultiContextPlan["fullReadReceipt"];
};

export type WorkflowTestFinalRequestInterceptor = (
  snapshot: WorkflowTestFinalRequestSnapshot,
) => Promise<boolean | void> | boolean | void;

let sendInterceptor: WorkflowTestSendInterceptor | null = null;
let finalRequestInterceptor: WorkflowTestFinalRequestInterceptor | null = null;

export function setWorkflowTestSendInterceptor(
  interceptor: WorkflowTestSendInterceptor | null,
): void {
  sendInterceptor = interceptor;
}

export function getWorkflowTestSendInterceptor(): WorkflowTestSendInterceptor | null {
  return sendInterceptor;
}

export function setWorkflowTestFinalRequestInterceptor(
  interceptor: WorkflowTestFinalRequestInterceptor | null,
): void {
  finalRequestInterceptor = interceptor;
}

export function getWorkflowTestFinalRequestInterceptor(): WorkflowTestFinalRequestInterceptor | null {
  return finalRequestInterceptor;
}
