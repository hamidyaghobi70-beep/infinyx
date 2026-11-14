import type { PolicyStopReason } from "./contracts.js";

interface EvaluateMessage {
  readonly type: "evaluate";
  readonly request: unknown;
  readonly deadlineAt?: number;
}

interface CancelMessage {
  readonly type: "cancel";
  readonly reason: PolicyStopReason;
}

interface FinalizeMessage {
  readonly type: "finalize";
}

type ParentMessage = EvaluateMessage | CancelMessage | FinalizeMessage;

interface PolicyEvaluator {
  evaluate(
    request: unknown,
    options: { readonly signal: AbortSignal; readonly deadlineAt?: number }
  ): Promise<unknown>;
}

let controller: AbortController | undefined;
let evaluationStarted = false;
let finalMessageSent = false;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sendProgress(message: unknown): void {
  if (process.connected && process.send) process.send(message);
}

function sendFinal(message: unknown): void {
  if (finalMessageSent) return;
  finalMessageSent = true;
  if (!process.connected || !process.send) return;
  // Keep stdio observable until the parent freezes the candidate and
  // acknowledges this final result. The parent still waits for "close".
  process.send(message);
}

async function execute(message: EvaluateMessage): Promise<void> {
  controller = new AbortController();
  try {
    const moduleSpecifier = process.argv[2];
    if (!moduleSpecifier) throw new Error("Policy evaluator module path is missing.");

    const loaded: unknown = await import(moduleSpecifier);
    if (!isRecord(loaded)) throw new Error("Policy evaluator module must export an object.");

    let evaluator: unknown = loaded.default ?? loaded.policyEngine;
    if (typeof loaded.createPolicyEngine === "function") {
      evaluator = await (loaded.createPolicyEngine as () => unknown)();
    }
    if (!isRecord(evaluator) || typeof evaluator.evaluate !== "function") {
      throw new Error("Policy evaluator module must export an evaluator with evaluate().");
    }
    if (controller.signal.aborted) {
      sendFinal({ type: "cancelled" });
      return;
    }

    sendProgress({ type: "started" });
    const options = {
      signal: controller.signal,
      ...(message.deadlineAt === undefined ? {} : { deadlineAt: message.deadlineAt })
    };
    const decision = await (evaluator as unknown as PolicyEvaluator).evaluate(
      message.request,
      options
    );
    sendFinal({ type: "result", decision });
  } catch (error) {
    sendFinal({
      type: "error",
      message: error instanceof Error ? error.message : "Policy evaluator failed."
    });
  }
}

process.on("message", (raw: unknown) => {
  if (!isRecord(raw)) return;
  const message = raw as unknown as ParentMessage;

  if (message.type === "finalize") {
    if (process.connected) process.disconnect();
    return;
  }

  if (message.type === "cancel") {
    controller?.abort({
      code: message.reason,
      message: "Policy evaluation cancellation requested."
    });
    return;
  }

  if (message.type === "evaluate" && !evaluationStarted) {
    evaluationStarted = true;
    void execute(message);
  }
});
