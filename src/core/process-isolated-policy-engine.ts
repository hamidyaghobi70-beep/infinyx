import { existsSync } from "node:fs";
import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type {
  PolicyCleanupStatus,
  PolicyDecision,
  PolicyEngine,
  PolicyExecutionLifecycleState,
  PolicyEvaluationOptions,
  PolicyExecutionRecord,
  PolicyRequest,
  PolicyRuntimeStatus,
  PolicyStopReason,
  PolicyTerminalOutcome
} from "./contracts.js";
import {
  isValidPolicyRequest,
  snapshotPolicyDecision,
  snapshotPolicyRequest
} from "./fail-closed-policy-engine.js";

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_TERMINATION_GRACE_MS = 100;
const DEFAULT_KILL_WAIT_MS = 1_000;
const DEFAULT_MAX_CONCURRENT = 4;
const DEFAULT_MAX_OLD_SPACE_SIZE_MB = 128;

interface Candidate {
  readonly outcome: PolicyTerminalOutcome;
  readonly decision: PolicyDecision;
  readonly stopReason?: PolicyStopReason;
}

interface ActiveExecution {
  readonly completion: Promise<PolicyExecutionRecord>;
  cancel(reason: PolicyStopReason): void;
}

export interface PolicyExecutionEvent {
  readonly executionId: string;
  readonly state: PolicyExecutionLifecycleState;
}

export interface ProcessIsolatedPolicyEngineOptions {
  readonly moduleUrl: string;
  readonly timeoutMs?: number;
  readonly terminationGraceMs?: number;
  readonly killWaitMs?: number;
  readonly maxConcurrent?: number;
  readonly maxOldSpaceSizeMb?: number;
  readonly onStateChange?: (event: PolicyExecutionEvent) => void;
}

function deny(reason: string): PolicyDecision {
  return Object.freeze({ effect: "deny", reason });
}

function makeRecord(
  lifecycle: PolicyExecutionLifecycleState,
  outcome: PolicyTerminalOutcome,
  decision: PolicyDecision,
  runtimeStatus: PolicyRuntimeStatus,
  cleanupStatus: PolicyCleanupStatus,
  stopReason?: PolicyStopReason
): PolicyExecutionRecord {
  return Object.freeze({
    lifecycle,
    outcome,
    decision,
    runtimeStatus,
    cleanupStatus,
    candidateFrozen: true,
    ...(stopReason === undefined ? {} : { stopReason })
  });
}

function normalizeModuleUrl(value: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError("A policy evaluator module URL is required.");
  }
  if (isAbsolute(value)) return pathToFileURL(value).href;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError("Policy evaluator module must be an absolute path or file URL.");
  }
  if (parsed.protocol !== "file:") {
    throw new TypeError("Policy evaluator module must use a file URL.");
  }
  return parsed.href;
}

function reasonFromSignal(signal: AbortSignal, fallback: PolicyStopReason): PolicyStopReason {
  const reason: unknown = signal.reason;
  if (typeof reason === "object" && reason !== null && "code" in reason) {
    const code = reason.code;
    if (code === "CALLER_CANCELLED" || code === "POLICY_TIMEOUT" ||
        code === "RUNTIME_SHUTDOWN" || code === "PARENT_CANCELLED") return code;
  }
  return fallback;
}

function stopMessage(reason: PolicyStopReason): string {
  switch (reason) {
    case "CALLER_CANCELLED":
      return "Policy execution cancelled by caller.";
    case "PARENT_CANCELLED":
      return "Parent operation cancelled policy execution.";
    case "RUNTIME_SHUTDOWN":
      return "Runtime shutdown cancelled policy execution.";
    case "POLICY_TIMEOUT":
      return "Policy execution timed out.";
  }
}

function getChildRunnerPath(): { path: string; execArgv: string[] } {
  const directory = dirname(fileURLToPath(import.meta.url));
  const compiled = join(directory, "policy-evaluator-child.js");
  const source = join(directory, "policy-evaluator-child.ts");
  if (existsSync(compiled)) return { path: compiled, execArgv: [] };
  if (existsSync(source)) {
    return { path: source, execArgv: ["--experimental-strip-types"] };
  }
  throw new Error("Policy evaluator child-process runner was not found.");
}

export class ProcessIsolatedPolicyEngine implements PolicyEngine {
  private readonly moduleUrl: string;
  private readonly timeoutMs: number;
  private readonly terminationGraceMs: number;
  private readonly killWaitMs: number;
  private readonly maxConcurrent: number;
  private readonly maxOldSpaceSizeMb: number;
  private readonly onStateChange: ((event: PolicyExecutionEvent) => void) | undefined;
  private readonly active = new Map<string, ActiveExecution>();
  private shuttingDown = false;

  constructor(options: ProcessIsolatedPolicyEngineOptions) {
    this.moduleUrl = normalizeModuleUrl(options.moduleUrl);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.terminationGraceMs = options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS;
    this.killWaitMs = options.killWaitMs ?? DEFAULT_KILL_WAIT_MS;
    this.maxConcurrent = options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
    this.maxOldSpaceSizeMb = options.maxOldSpaceSizeMb ?? DEFAULT_MAX_OLD_SPACE_SIZE_MB;
    this.onStateChange = options.onStateChange;

    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0 ||
        !Number.isFinite(this.terminationGraceMs) || this.terminationGraceMs < 0 ||
        !Number.isFinite(this.killWaitMs) || this.killWaitMs <= 0 ||
        !Number.isInteger(this.maxConcurrent) || this.maxConcurrent < 1 ||
        !Number.isInteger(this.maxOldSpaceSizeMb) || this.maxOldSpaceSizeMb < 16) {
      throw new RangeError("Policy runtime limits must be finite and positive.");
    }
  }

  get activeExecutionCount(): number {
    return this.active.size;
  }

  async evaluate(
    request: PolicyRequest,
    options?: PolicyEvaluationOptions
  ): Promise<PolicyDecision> {
    const result = await this.evaluateDetailed(request, options);
    return result.decision;
  }

  async evaluateDetailed(
    request: PolicyRequest,
    options?: PolicyEvaluationOptions
  ): Promise<PolicyExecutionRecord> {
    const input = snapshotPolicyRequest(request);
    if (!input || !isValidPolicyRequest(input)) {
      return makeRecord("TERMINAL", "DENIED",
        deny("Policy request is invalid or unsafe; access denied."),
        "NOT_STARTED", "NOT_REQUIRED");
    }
    if (this.shuttingDown) {
      return makeRecord("TERMINAL", "CANCELLED",
        deny("Runtime shutdown is in progress; access denied."),
        "NOT_STARTED", "NOT_REQUIRED", "RUNTIME_SHUTDOWN");
    }
    if (options?.signal?.aborted) {
      const reason = reasonFromSignal(options.signal, "CALLER_CANCELLED");
      return makeRecord("TERMINAL", "CANCELLED", deny(stopMessage(reason)),
        "NOT_STARTED", "NOT_REQUIRED", reason);
    }
    if (options?.parentSignal?.aborted) {
      return makeRecord("TERMINAL", "CANCELLED", deny(stopMessage("PARENT_CANCELLED")),
        "NOT_STARTED", "NOT_REQUIRED", "PARENT_CANCELLED");
    }

    const deadlineRemaining = options?.deadlineAt === undefined
      ? this.timeoutMs
      : options.deadlineAt - Date.now();
    if (deadlineRemaining <= 0) {
      return makeRecord("TERMINAL", "TIMED_OUT", deny(stopMessage("POLICY_TIMEOUT")),
        "NOT_STARTED", "NOT_REQUIRED", "POLICY_TIMEOUT");
    }
    if (this.active.size >= this.maxConcurrent) {
      return makeRecord("TERMINAL", "FAILED",
        deny("Policy runtime capacity is exhausted; access denied."),
        "NOT_STARTED", "NOT_REQUIRED");
    }

    const executionId = randomUUID();
    const timeoutMs = Math.min(this.timeoutMs, deadlineRemaining);
    const deadlineAt = options?.deadlineAt === undefined
      ? Date.now() + timeoutMs
      : Math.min(options.deadlineAt, Date.now() + this.timeoutMs);
    const runner = getChildRunnerPath();
    const child = fork(runner.path, [this.moduleUrl], {
      cwd: process.cwd(),
      env: { NODE_ENV: "production" },
      execArgv: [...runner.execArgv, `--max-old-space-size=${this.maxOldSpaceSizeMb}`],
      silent: true,
      serialization: "advanced",
      windowsHide: true
    });

    child.stdout?.resume();
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer | string) => {
      if (stderr.length < 4_096) stderr += String(chunk).slice(0, 4_096 - stderr.length);
    });

    let resolveCompletion!: (record: PolicyExecutionRecord) => void;
    const completion = new Promise<PolicyExecutionRecord>((resolve) => {
      resolveCompletion = resolve;
    });

    let candidate: Candidate | undefined;
    let candidateFrozen = false;
    let spawned = false;
    let closed = false;
    let resolved = false;
    let stopReason: PolicyStopReason | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    let killWaitTimer: ReturnType<typeof setTimeout> | undefined;
    let callerAbort: (() => void) | undefined;
    let parentAbort: (() => void) | undefined;

    const notify = (state: PolicyExecutionLifecycleState): void => {
      try {
        this.onStateChange?.({ executionId, state });
      } catch {
        // Observability callbacks must never alter policy execution.
      }
    };

    const clearTimers = (): void => {
      if (timeout !== undefined) clearTimeout(timeout);
      if (graceTimer !== undefined) clearTimeout(graceTimer);
      if (killWaitTimer !== undefined) clearTimeout(killWaitTimer);
      timeout = undefined;
      graceTimer = undefined;
      killWaitTimer = undefined;
    };

    const removeAbortListeners = (): void => {
      if (callerAbort && options?.signal) options.signal.removeEventListener("abort", callerAbort);
      if (parentAbort && options?.parentSignal) {
        options.parentSignal.removeEventListener("abort", parentAbort);
      }
    };

    const finishUnresolved = (): void => {
      if (resolved || closed) return;
      resolved = true;
      clearTimers();
      removeAbortListeners();
      notify("UNRESOLVED");
      resolveCompletion(makeRecord(
        "UNRESOLVED",
        "UNRESOLVED",
        deny("Policy process termination could not be confirmed; access denied."),
        "UNRESOLVED",
        "UNRESOLVED",
        stopReason
      ));
    };

    const scheduleHardTermination = (): void => {
      if (graceTimer !== undefined || closed || resolved) return;
      graceTimer = setTimeout(() => {
        if (closed || resolved) return;
        child.kill();
        killWaitTimer = setTimeout(finishUnresolved, this.killWaitMs);
      }, this.terminationGraceMs);
    };

    const requestStop = (reason: PolicyStopReason): void => {
      if (candidateFrozen || resolved || closed) return;
      candidateFrozen = true;
      stopReason = reason;
      candidate = {
        outcome: reason === "POLICY_TIMEOUT" ? "TIMED_OUT" : "CANCELLED",
        decision: deny(stopMessage(reason)),
        stopReason: reason
      };
      notify("STOP_REQUESTED");
      if (spawned && child.connected) {
        try {
          child.send({ type: "cancel", reason });
        } catch {
          // The hard-termination path remains authoritative.
        }
      }
      scheduleHardTermination();
    };

    const freezeCandidate = (next: Candidate): void => {
      if (candidateFrozen || resolved || closed) return;
      candidateFrozen = true;
      candidate = next;
      if (next.outcome === "COMPLETED") notify("AUTHORIZED");
      notify("FINALIZING");
      scheduleHardTermination();
    };

    this.active.set(executionId, { completion, cancel: requestStop });
    notify("CREATED");
    notify("AUTHORIZING");

    if (options?.signal) {
      callerAbort = () => requestStop(reasonFromSignal(options.signal!, "CALLER_CANCELLED"));
      options.signal.addEventListener("abort", callerAbort, { once: true });
    }
    if (options?.parentSignal) {
      parentAbort = () => requestStop("PARENT_CANCELLED");
      options.parentSignal.addEventListener("abort", parentAbort, { once: true });
    }
    timeout = setTimeout(() => requestStop("POLICY_TIMEOUT"), timeoutMs);

    child.once("spawn", () => {
      spawned = true;
      if (candidateFrozen || this.shuttingDown) {
        if (!candidateFrozen) requestStop("RUNTIME_SHUTDOWN");
        if (graceTimer !== undefined) clearTimeout(graceTimer);
        child.kill();
        killWaitTimer = setTimeout(finishUnresolved, this.killWaitMs);
        return;
      }
      try {
        child.send({ type: "evaluate", request: input, deadlineAt });
      } catch {
        freezeCandidate({
          outcome: "FAILED",
          decision: deny("Policy runtime IPC failed; access denied.")
        });
      }
    });

    child.on("message", (raw: unknown) => {
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return;
      const message = raw as Record<string, unknown>;
      if (message.type === "started") {
        if (!candidateFrozen && !resolved) notify("RUNNING");
        return;
      }
      if (message.type === "result") {
        const decision = snapshotPolicyDecision(message.decision);
        if (!decision) {
          freezeCandidate({
            outcome: "DENIED",
            decision: deny("Policy evaluator returned an invalid decision; access denied.")
          });
          return;
        }
        freezeCandidate({
          outcome: decision.effect === "allow" ? "COMPLETED" : "DENIED",
          decision
        });
        return;
      }
      if (message.type === "error" && typeof message.message === "string") {
        freezeCandidate({
          outcome: "FAILED",
          decision: deny(
            "Policy evaluator process failed; access denied. " +
            message.message.trim().slice(0, 500)
          )
        });
      }
    });

    child.once("error", () => {
      freezeCandidate({
        outcome: "FAILED",
        decision: deny("Policy evaluator process could not be started; access denied.")
      });
    });

    child.once("close", (code) => {
      closed = true;
      clearTimers();
      removeAbortListeners();
      this.active.delete(executionId);
      if (resolved) return;

      if (!candidateFrozen || !candidate) {
        candidateFrozen = true;
        candidate = {
          outcome: "FAILED",
          decision: deny(
            "Policy evaluator process exited without a valid result; access denied." +
            (stderr.trim() ? " " + stderr.trim().slice(0, 500) : "")
          )
        };
      }

      let outcome = candidate.outcome;
      let decision = candidate.decision;
      if ((outcome === "COMPLETED" || outcome === "DENIED") && code !== 0) {
        outcome = "FAILED";
        decision = deny("Policy evaluator process exited abnormally; access denied.");
      }

      notify("TERMINAL");
      resolved = true;
      resolveCompletion(makeRecord(
        "TERMINAL",
        outcome,
        decision,
        "STOPPED",
        "COMPLETED",
        candidate.stopReason
      ));
    });

    if (options?.signal?.aborted) {
      requestStop(reasonFromSignal(options.signal, "CALLER_CANCELLED"));
    } else if (options?.parentSignal?.aborted) {
      requestStop("PARENT_CANCELLED");
    }

    return completion;
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    const executions = [...this.active.values()];
    for (const execution of executions) execution.cancel("RUNTIME_SHUTDOWN");
    const results = await Promise.all(executions.map((execution) => execution.completion));
    if (results.some((result) => result.outcome === "UNRESOLVED")) {
      throw new Error("One or more policy child processes remain unresolved.");
    }
  }
}
