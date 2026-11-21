import type { PolicyStopReason } from "./contracts.js";

interface EvaluateMessage {
  readonly type: "evaluate";
  readonly token: string;
  readonly request: unknown;
  readonly deadlineAt?: number;
}

interface CancelMessage {
  readonly type: "cancel";
  readonly reason: PolicyStopReason;
}

type ParentMessage = EvaluateMessage | CancelMessage;

interface PolicyEvaluator {
  evaluate(
    request: unknown,
    options: { readonly signal: AbortSignal; readonly deadlineAt?: number }
  ): Promise<unknown>;
}

let controller: AbortController | undefined;
let evaluationStarted = false;
let finalMessageSent = false;
let responseToken: string | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sendProgress(message: Record<string, unknown>): void {
  if (process.connected && process.send && responseToken) {
    process.send({ ...message, token: responseToken });
  }
}

function sendFinal(message: unknown): void {
  if (finalMessageSent) return;
  finalMessageSent = true;
  if (!process.connected || !process.send) return;
  if (!responseToken) return;
  process.send({ ...(message as Record<string, unknown>), token: responseToken }, () => {
    if (process.connected) process.disconnect();
  });
}

async function execute(message: EvaluateMessage): Promise<void> {
  responseToken = message.token;
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
    // Keep evaluator-controlled exception text inside the child process.
    sendFinal({ type: "error" });
  }
}

process.on("message", (raw: unknown) => {
  if (!isRecord(raw)) return;
  const message = raw as unknown as ParentMessage;

  if (message.type === "cancel") {
    controller?.abort({
      code: message.reason,
      message: "Policy evaluation cancellation requested."
    });
    return;
  }

  if (message.type === "evaluate" && !evaluationStarted &&
      typeof message.token === "string" && message.token.length >= 32) {
    evaluationStarted = true;
    void execute(message);
  }
});
