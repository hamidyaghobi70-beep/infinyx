import type {
  EventBusPort,
  MemoryAddress,
  MemoryPort,
  PolicyEngine,
  PolicyRequest
} from "./contracts.js";
import { MemoryAccessError } from "./memory-error.js";

/** Published before every memory operation is executed or refused. */
export const MEMORY_ACCESS_DECIDED_EVENT = "memory.access.decided";
/** Published (best effort) when the backing store fails after an allow decision. */
export const MEMORY_ACCESS_FAILED_EVENT = "memory.access.failed";
export const DEFAULT_MAX_MEMORY_VALUE_BYTES = 64 * 1024;

const MAX_SCOPE_SEGMENT_LENGTH = 128;
const MAX_NAMESPACE_LENGTH = 128;
const MAX_KEY_LENGTH = 256;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;

export type MemoryOperation = "read" | "write" | "delete";

/**
 * Identity binding for one guarded port. It must be issued by the composition root
 * from an authenticated principal. Core v1 does not authenticate: a module must never
 * be able to choose its own tenantId or actorId.
 */
export interface MemoryScope {
  readonly tenantId: string;
  readonly actorId: string;
  readonly moduleId: string;
}

export interface GuardedMemoryPortOptions {
  readonly store: MemoryPort;
  readonly policy: PolicyEngine;
  readonly events: EventBusPort;
  readonly scope: MemoryScope;
  /** Maximum serialized (UTF-8 JSON) value size. Defaults to 64 KiB. */
  readonly maxValueBytes?: number;
}

/** Audit payload. Never contains the stored value. */
export interface MemoryAccessDecidedEvent extends MemoryScope {
  readonly operation: MemoryOperation;
  readonly namespace: string;
  readonly key: string;
  readonly decision: "allow" | "deny";
  readonly reason: string;
}

export interface MemoryAccessFailedEvent extends MemoryScope {
  readonly operation: MemoryOperation;
  readonly namespace: string;
  readonly key: string;
  readonly errorName: string;
}

interface ResolvedTarget {
  readonly namespace: string;
  readonly key: string;
  readonly inner: MemoryAddress;
  readonly resource: string;
}

interface NormalizedDecision {
  readonly effect: "allow" | "deny";
  readonly reason: string;
}

/**
 * Tenant-scoped, policy-checked, audited decorator over a MemoryPort.
 *
 * Enforced for every operation, in order:
 *   1. address and value validation (before any policy or backend call);
 *   2. policy evaluation, default-deny, fail-closed on errors or malformed decisions;
 *   3. audit event publication, fail-closed for allow decisions;
 *   4. backend call against an address that is namespaced by tenant.
 *
 * Values are stored as canonical JSON strings, so backends never receive live object
 * references and callers never receive references into stored data.
 *
 * This class provides isolation and access control logic only. Encryption at rest,
 * key management, retention, backup and durable audit storage are NOT provided.
 */
export class GuardedMemoryPort implements MemoryPort {
  private readonly store: MemoryPort;
  private readonly policy: PolicyEngine;
  private readonly events: EventBusPort;
  private readonly scope: MemoryScope;
  private readonly maxValueBytes: number;

  /** Module identity bound to this capability by the composition root. */
  get scopeModuleId(): string {
    return this.scope.moduleId;
  }

  constructor(options: GuardedMemoryPortOptions) {
    if (!options || typeof options !== "object") {
      throw new TypeError("GuardedMemoryPort options are required.");
    }
    if (!hasMethods(options.store, ["read", "write", "delete"])) {
      throw new TypeError("GuardedMemoryPort requires a MemoryPort store.");
    }
    if (!hasMethods(options.policy, ["evaluate"])) {
      throw new TypeError("GuardedMemoryPort requires a PolicyEngine.");
    }
    if (!hasMethods(options.events, ["publish"])) {
      throw new TypeError("GuardedMemoryPort requires an EventBusPort.");
    }

    const maxValueBytes = options.maxValueBytes ?? DEFAULT_MAX_MEMORY_VALUE_BYTES;
    if (!Number.isSafeInteger(maxValueBytes) || maxValueBytes <= 0) {
      throw new TypeError("maxValueBytes must be a positive safe integer.");
    }

    const scope = options.scope as Partial<MemoryScope> | undefined;
    if (
      !scope ||
      !isValidSegment(scope.tenantId, MAX_SCOPE_SEGMENT_LENGTH) ||
      !isValidSegment(scope.actorId, MAX_SCOPE_SEGMENT_LENGTH) ||
      !isValidSegment(scope.moduleId, MAX_SCOPE_SEGMENT_LENGTH)
    ) {
      throw new MemoryAccessError(
        "MEMORY_INVALID_SCOPE",
        "tenantId, actorId and moduleId must be non-empty strings without control characters."
      );
    }

    this.store = options.store;
    this.policy = options.policy;
    this.events = options.events;
    this.maxValueBytes = maxValueBytes;
    this.scope = Object.freeze({
      tenantId: scope.tenantId,
      actorId: scope.actorId,
      moduleId: scope.moduleId
    });
  }

  async read(address: MemoryAddress): Promise<unknown | null> {
    const target = this.resolve(address);
    await this.authorize("read", target);

    return this.callStore("read", target, async () => {
      const stored = await this.store.read(target.inner);
      if (stored === null) return null;
      if (typeof stored !== "string") {
        throw new TypeError("Backing store returned a value that is not a serialized string.");
      }
      return JSON.parse(stored) as unknown;
    });
  }

  async write(address: MemoryAddress, value: unknown): Promise<void> {
    const target = this.resolve(address);
    const serialized = this.serialize(value);
    await this.authorize("write", target);
    await this.callStore("write", target, () => this.store.write(target.inner, serialized));
  }

  async delete(address: MemoryAddress): Promise<void> {
    const target = this.resolve(address);
    await this.authorize("delete", target);
    await this.callStore("delete", target, () => this.store.delete(target.inner));
  }

  private resolve(address: MemoryAddress): ResolvedTarget {
    const candidate = address as Partial<MemoryAddress> | null | undefined;
    if (
      !candidate ||
      typeof candidate !== "object" ||
      !isValidSegment(candidate.namespace, MAX_NAMESPACE_LENGTH) ||
      !isValidSegment(candidate.key, MAX_KEY_LENGTH)
    ) {
      throw new MemoryAccessError(
        "MEMORY_INVALID_ADDRESS",
        "Memory namespace and key must be non-empty strings without control characters within length limits."
      );
    }

    const { namespace, key } = candidate;
    const tenant = encodeURIComponent(this.scope.tenantId);
    const encodedNamespace = encodeURIComponent(namespace);

    return {
      namespace,
      key,
      // Encoded segments cannot contain "/", so (tenant, namespace) is unambiguous even
      // if a backend flattens namespace and key into a single string.
      inner: Object.freeze({ namespace: `${tenant}/${encodedNamespace}`, key }),
      resource: `memory://${tenant}/${encodedNamespace}/${encodeURIComponent(key)}`
    };
  }

  private serialize(value: unknown): string {
    let serialized: unknown;
    try {
      serialized = JSON.stringify(value);
    } catch (cause) {
      throw new MemoryAccessError(
        "MEMORY_INVALID_VALUE",
        "Memory value must be JSON-serializable.",
        { cause }
      );
    }

    if (typeof serialized !== "string") {
      throw new MemoryAccessError("MEMORY_INVALID_VALUE", "Memory value must be JSON-serializable.");
    }
    if (Buffer.byteLength(serialized, "utf8") > this.maxValueBytes) {
      throw new MemoryAccessError(
        "MEMORY_INVALID_VALUE",
        `Memory value exceeds the ${this.maxValueBytes} byte limit.`
      );
    }
    return serialized;
  }

  private async authorize(operation: MemoryOperation, target: ResolvedTarget): Promise<void> {
    const request: PolicyRequest = {
      actorId: this.scope.actorId,
      action: `memory.${operation}`,
      resource: target.resource,
      context: {
        attributes: Object.freeze({
          tenantId: this.scope.tenantId,
          moduleId: this.scope.moduleId,
          namespace: target.namespace
        })
      }
    };

    let decision: NormalizedDecision;
    try {
      decision = normalizeDecision(await this.policy.evaluate(request));
    } catch {
      decision = { effect: "deny", reason: "Policy evaluation failed." };
    }

    const audit: MemoryAccessDecidedEvent = Object.freeze({
      ...this.scope,
      operation,
      namespace: target.namespace,
      key: target.key,
      decision: decision.effect,
      reason: decision.reason
    });

    try {
      if (this.events.hasSubscribers?.(MEMORY_ACCESS_DECIDED_EVENT) !== true) {
        throw new Error("No memory audit subscriber is registered.");
      }
      await this.events.publish(MEMORY_ACCESS_DECIDED_EVENT, audit);
    } catch (cause) {
      // An allowed operation that cannot be audited is refused. A denial is refused
      // either way, so its outcome does not depend on the audit sink.
      if (decision.effect === "allow") {
        throw new MemoryAccessError(
          "MEMORY_AUDIT_UNAVAILABLE",
          "Memory access could not be audited and was refused.",
          { cause }
        );
      }
    }

    if (decision.effect !== "allow") {
      throw new MemoryAccessError("MEMORY_ACCESS_DENIED", "Memory access denied.");
    }
  }

  private async callStore<T>(
    operation: MemoryOperation,
    target: ResolvedTarget,
    action: () => Promise<T>
  ): Promise<T> {
    try {
      return await action();
    } catch (cause) {
      await this.reportFailure(operation, target, cause);
      throw new MemoryAccessError("MEMORY_BACKEND_FAILED", "Memory backend operation failed.", {
        cause
      });
    }
  }

  private async reportFailure(
    operation: MemoryOperation,
    target: ResolvedTarget,
    cause: unknown
  ): Promise<void> {
    const failure: MemoryAccessFailedEvent = Object.freeze({
      ...this.scope,
      operation,
      namespace: target.namespace,
      key: target.key,
      errorName: cause instanceof Error ? cause.name : "UnknownError"
    });

    try {
      await this.events.publish(MEMORY_ACCESS_FAILED_EVENT, failure);
    } catch {
      // Intentionally ignored: reporting must never mask the original backend failure.
    }
  }
}

function hasMethods(value: unknown, names: readonly string[]): boolean {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return names.every((name) => typeof record[name] === "function");
}

function isValidSegment(value: unknown, maxLength: number): value is string {
  if (typeof value !== "string") return false;
  if (value.trim().length === 0 || value.length > maxLength) return false;
  if (CONTROL_CHARACTERS.test(value)) return false;
  try {
    // Lone surrogates make encodeURIComponent throw; reject them as malformed.
    encodeURIComponent(value);
  } catch {
    return false;
  }
  return true;
}

function normalizeDecision(result: unknown): NormalizedDecision {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return { effect: "deny", reason: "Policy returned an invalid decision." };
  }

  const { effect, reason } = result as { effect?: unknown; reason?: unknown };
  if ((effect !== "allow" && effect !== "deny") || typeof reason !== "string" || !reason.trim()) {
    return { effect: "deny", reason: "Policy returned an invalid decision." };
  }
  return { effect, reason };
}
