import {
  DEFAULT_AGENT_TIMEOUT_MS,
  MAX_AGENT_OUTPUT_LENGTH,
  MAX_AGENT_PROMPT_LENGTH,
  MAX_AGENT_TIMEOUT_MS,
  MAX_ACTIVE_TASKS,
  MAX_TRACKED_TASKS,
  type AgentExecutionState,
  type AgentRuntimeOptions,
  type AgentTaskRecord,
  type AgentTaskRequest,
  type AgentTaskResult,
  type AgentTaskStatus
} from "./agent-contracts.js";
import { AgentOrchestrator } from "./agent-orchestrator.js";
import type { ModelPort } from "./model-port.js";
import { TaskPlanner } from "./task-planner.js";

interface MutableTaskRecord {
  taskId: string;
  status: AgentTaskStatus;
  executionState: AgentExecutionState;
  startedAt: number;
  finishedAt?: number;
  reason?: string;
}

interface ActiveTask {
  readonly controller: AbortController;
  readonly record: MutableTaskRecord;
  readonly settled: Promise<void>;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function readDataProperties(value: Record<string, unknown>): Record<string, unknown> | undefined {
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string") return undefined;
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor) || descriptor.get || descriptor.set) return undefined;
    result[key] = descriptor.value;
  }
  return result;
}

function validateRequest(value: unknown, options: Required<AgentRuntimeOptions>):
  | { readonly ok: true; readonly taskId: string; readonly prompt: string; readonly timeoutMs: number; readonly signal?: AbortSignal }
  | { readonly ok: false; readonly reason: string } {
  if (!isPlainRecord(value)) return { ok: false, reason: "Task request must be a plain object." };
  const data = readDataProperties(value);
  if (!data) return { ok: false, reason: "Task request contains unsafe properties." };
  const allowed = new Set(["taskId", "prompt", "timeoutMs", "signal"]);
  if (Object.keys(data).some((key) => !allowed.has(key))) {
    return { ok: false, reason: "Task request contains unsupported fields." };
  }
  if (typeof data.taskId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(data.taskId)) {
    return { ok: false, reason: "Task identifier is invalid." };
  }
  if (typeof data.prompt !== "string" || !data.prompt.trim() ||
      data.prompt.length > options.maxPromptLength) {
    return { ok: false, reason: "Prompt is empty or exceeds the configured limit." };
  }
  const timeoutMs = data.timeoutMs === undefined ? options.defaultTimeoutMs : data.timeoutMs;
  if (typeof timeoutMs !== "number" || !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 || timeoutMs > MAX_AGENT_TIMEOUT_MS) {
    return { ok: false, reason: "Task timeout is outside the permitted range." };
  }
  if (data.signal !== undefined &&
      !(typeof AbortSignal !== "undefined" && data.signal instanceof AbortSignal)) {
    return { ok: false, reason: "Task cancellation signal is invalid." };
  }
  return {
    ok: true,
    taskId: data.taskId,
    prompt: data.prompt,
    timeoutMs,
    ...(data.signal === undefined ? {} : { signal: data.signal as AbortSignal })
  };
}

export class AgentRuntime {
  private readonly orchestrator: AgentOrchestrator;
  private readonly options: Required<AgentRuntimeOptions>;
  private readonly active = new Map<string, ActiveTask>();
  private readonly records = new Map<string, MutableTaskRecord>();
  private accepting = false;

  constructor(model: ModelPort, options: AgentRuntimeOptions = {}) {
    this.options = {
      defaultTimeoutMs: options.defaultTimeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS,
      maxPromptLength: options.maxPromptLength ?? MAX_AGENT_PROMPT_LENGTH,
      maxOutputLength: options.maxOutputLength ?? MAX_AGENT_OUTPUT_LENGTH
    };
    if (!Number.isSafeInteger(this.options.defaultTimeoutMs) ||
        this.options.defaultTimeoutMs < 1 || this.options.defaultTimeoutMs > MAX_AGENT_TIMEOUT_MS ||
        !Number.isSafeInteger(this.options.maxPromptLength) ||
        this.options.maxPromptLength < 1 || this.options.maxPromptLength > MAX_AGENT_PROMPT_LENGTH ||
        !Number.isSafeInteger(this.options.maxOutputLength) ||
        this.options.maxOutputLength < 1 || this.options.maxOutputLength > MAX_AGENT_OUTPUT_LENGTH) {
      throw new RangeError("Agent runtime limits are invalid.");
    }
    this.orchestrator = new AgentOrchestrator(new TaskPlanner(), model);
  }

  start(): void {
    if (this.accepting) throw new Error("Agent runtime is already running.");
    if (this.active.size > 0) throw new Error("Agent runtime has unresolved tasks.");
    this.accepting = true;
  }

  get isAccepting(): boolean {
    return this.accepting;
  }

  getTaskStatus(taskId: string): AgentTaskRecord | undefined {
    const record = this.records.get(taskId);
    return record ? Object.freeze({ ...record }) : undefined;
  }

  async execute(request: AgentTaskRequest | unknown, parentSignal?: AbortSignal): Promise<AgentTaskResult> {
    if (!this.accepting) {
      return { status: "rejected", taskId: "unknown", reason: "Agent runtime is not accepting tasks." };
    }
    let validated: ReturnType<typeof validateRequest>;
    try {
      validated = validateRequest(request, this.options);
    } catch {
      return { status: "rejected", taskId: "unknown", reason: "Task request could not be safely inspected." };
    }
    if (!validated.ok) {
      return { status: "rejected", taskId: "unknown", reason: validated.reason };
    }
    const { taskId, prompt, timeoutMs, signal } = validated;
    if (this.active.has(taskId)) {
      return { status: "rejected", taskId, reason: "A task with this identifier is already active." };
    }
    if (signal?.aborted || parentSignal?.aborted) {
      return { status: "cancelled", taskId, executionState: "settled" };
    }
    if (this.active.size >= MAX_ACTIVE_TASKS) {
      return { status: "rejected", taskId, reason: "Agent runtime has reached its active task limit.", code: "CAPACITY_EXCEEDED" };
    }

    const controller = new AbortController();
    const startedAt = Date.now();
    const record: MutableTaskRecord = {
      taskId, status: "running", executionState: "running", startedAt
    };
    let resolveTask!: () => void;
    const taskSettled = new Promise<void>((resolve) => { resolveTask = resolve; });
    this.active.set(taskId, { controller, record, settled: taskSettled });
    this.remember(record);

    let providerStarted = false;
    let providerSettled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let callerAbort: (() => void) | undefined;
    let parentAbort: (() => void) | undefined;

    const recordCancellation = (status: "cancelled" | "timed_out", reason: string): void => {
      if (record.status !== "running") return;
      record.status = status;
      record.executionState = providerSettled ? "settled" : "unresolved";
      record.reason = reason;
      if (providerSettled) record.finishedAt = Date.now();
    };

    const controllerAbort = (): void => {
      // If cancellation wins before the provider microtask starts, no external
      // execution exists to remain unresolved.
      if (!providerStarted) providerSettled = true;
      if (controller.signal.reason === "deadline_exceeded") {
        recordCancellation("timed_out", "Task deadline elapsed.");
      } else {
        recordCancellation("cancelled", "Task cancellation was requested.");
      }
    };
    controller.signal.addEventListener("abort", controllerAbort, { once: true });

    if (signal) {
      callerAbort = () => {
        if (!controller.signal.aborted) controller.abort("caller_cancelled");
      };
      signal.addEventListener("abort", callerAbort, { once: true });
      if (signal.aborted) callerAbort();
    }
    if (parentSignal) {
      parentAbort = () => {
        if (!controller.signal.aborted) controller.abort("core_shutdown");
      };
      parentSignal.addEventListener("abort", parentAbort, { once: true });
      if (parentSignal.aborted) parentAbort();
    }

    timeout = setTimeout(() => {
      if (!controller.signal.aborted) controller.abort("deadline_exceeded");
    }, timeoutMs);

    const deadlineAt = startedAt + timeoutMs;
    const providerPromise = Promise.resolve().then(() => {
      // Shutdown/cancellation may happen before this microtask executes.
      // Do not start ModelPort work after the task has already been aborted.
      if (controller.signal.aborted) {
        throw new Error("Task was cancelled before ModelPort invocation.");
      }
      providerStarted = true;
      return this.orchestrator.run(prompt, controller.signal, deadlineAt);
    });
    const observedProvider = providerPromise.then(
      (output): AgentTaskResult => {
        providerSettled = true;
        if (typeof output !== "string" || !output.trim() || output.length > this.options.maxOutputLength) {
          if (record.status === "running") {
            record.status = "error";
            record.reason = "Model provider returned an invalid response.";
            record.finishedAt = Date.now();
          }
          record.executionState = "settled";
          record.finishedAt = Date.now();
          this.active.delete(taskId);
          resolveTask();
          return record.status === "cancelled"
            ? { status: "cancelled", taskId, executionState: "settled" }
            : record.status === "timed_out"
              ? { status: "timed_out", taskId, executionState: "settled" }
              : { status: "error", taskId, code: "INVALID_MODEL_RESPONSE" };
        }
        if (record.status === "running") {
          record.status = "completed";
          record.executionState = "settled";
          record.finishedAt = Date.now();
        } else {
          record.executionState = "settled";
          record.finishedAt = Date.now();
        }
        this.active.delete(taskId);
        resolveTask();
        return record.status === "completed"
          ? { status: "completed", taskId, output }
          : record.status === "cancelled"
            ? { status: "cancelled", taskId, executionState: "settled" }
            : { status: "timed_out", taskId, executionState: "settled" };
      },
      (error: unknown): AgentTaskResult => {
        providerSettled = true;
        record.executionState = "settled";
        record.finishedAt = Date.now();
        this.active.delete(taskId);
        resolveTask();
        if (record.status === "running") {
          record.status = "error";
          record.reason = error instanceof Error ? error.message : "Model provider failed.";
          return { status: "error", taskId, code: "MODEL_PROVIDER_ERROR" };
        }
        return record.status === "cancelled"
          ? { status: "cancelled", taskId, executionState: "settled" }
          : { status: "timed_out", taskId, executionState: "settled" };
      }
    );

    try {
      // Never race cancellation against the provider promise. The protected-operation
      // handler remains active until the underlying ModelPort work truly settles.
      return await observedProvider;
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      if (callerAbort && signal) signal.removeEventListener("abort", callerAbort);
      if (parentAbort && parentSignal) parentSignal.removeEventListener("abort", parentAbort);
      controller.signal.removeEventListener("abort", controllerAbort);
      this.trimRecords();
    }
  }

  async shutdown(): Promise<void> {
    this.accepting = false;
    const active = [...this.active.values()];
    for (const task of active) {
      if (!task.controller.signal.aborted) task.controller.abort("runtime_shutdown");
    }
    // Shutdown is complete only after every actual ModelPort promise settles.
    while (this.active.size > 0) {
      await Promise.all([...this.active.values()].map((task) => task.settled));
    }
  }

  private remember(record: MutableTaskRecord): void {
    this.records.set(record.taskId, record);
    this.trimRecords();
  }

  private trimRecords(): void {
    if (this.records.size <= MAX_TRACKED_TASKS) return;
    for (const [taskId, record] of this.records) {
      if (this.records.size <= MAX_TRACKED_TASKS) break;
      if (!this.active.has(taskId) && record.executionState === "settled") this.records.delete(taskId);
    }
  }
}
