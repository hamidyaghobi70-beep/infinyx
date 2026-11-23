import {
  createPrincipalMemoryScope,
  isAuthenticatedPrincipal,
  type AuthenticatedPrincipal
} from "./authenticated-principal.js";
import {
  GuardedMemoryPort,
  type GuardedMemoryPortOptions,
  type MemoryAuditPort
} from "./guarded-memory-port.js";
import type { MemoryPort, PolicyEngine } from "./contracts.js";

export interface AuthenticatedMemorySessionOptions {
  readonly principal: AuthenticatedPrincipal;
  readonly moduleId: string;
  readonly store: MemoryPort;
  readonly policy: PolicyEngine;
  readonly audit: MemoryAuditPort;
  readonly maxValueBytes?: number;
  readonly policyTimeoutMs?: number;
  readonly auditTimeoutMs?: number;
}

/**
 * Creates a request-scoped memory capability from a verifier-issued principal.
 * Do not cache this capability across requests or substitute caller-supplied IDs.
 * This is deliberately separate from CoreEngine's module-lifetime context.
 */
export function createAuthenticatedMemorySession(
  options: AuthenticatedMemorySessionOptions
): GuardedMemoryPort {
  if (!options || typeof options !== "object" || !isAuthenticatedPrincipal(options.principal)) {
    throw new TypeError("A verifier-issued authenticated principal is required.");
  }
  const scope = createPrincipalMemoryScope(options.principal, options.moduleId);
  const guardedOptions: GuardedMemoryPortOptions = {
    store: options.store,
    policy: options.policy,
    audit: options.audit,
    scope,
    ...(options.maxValueBytes === undefined ? {} : { maxValueBytes: options.maxValueBytes }),
    ...(options.policyTimeoutMs === undefined ? {} : { policyTimeoutMs: options.policyTimeoutMs }),
    ...(options.auditTimeoutMs === undefined ? {} : { auditTimeoutMs: options.auditTimeoutMs })
  };
  return new GuardedMemoryPort(guardedOptions);
}
