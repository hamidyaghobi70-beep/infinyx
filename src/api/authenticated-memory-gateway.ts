import type { Request, RequestHandler, Response } from "express";
import type { MemoryPort, PolicyEngine } from "../core/contracts.js";
import {
  createAuthenticatedMemorySession
} from "../core/authenticated-memory-session.js";
import {
  getAuthenticatedPrincipal
} from "../core/authenticated-principal.js";
import type { MemoryAuditPort } from "../core/guarded-memory-port.js";
import { GuardedMemoryPort } from "../core/guarded-memory-port.js";

// A private weak association prevents response.locals or downstream middleware from
// injecting or replacing the capability returned for a request.
const requestSessions = new WeakMap<Response, GuardedMemoryPort>();

export interface AuthenticatedMemoryGatewayOptions {
  /** Fixed by trusted server composition; never read from request input. */
  readonly moduleId: string;
  readonly store: MemoryPort;
  readonly policy: PolicyEngine;
  readonly audit: MemoryAuditPort;
}

/**
 * Creates a new guarded memory capability for each authenticated HTTP request.
 * The capability is held in a private WeakMap keyed by the Express response;
 * it is never exposed through mutable response.locals, installed in CoreEngine's
 * module-lifetime context, or shared across concurrent requests.
 */
export function createAuthenticatedMemoryGateway(
  options: AuthenticatedMemoryGatewayOptions
): RequestHandler {
  if (!options || typeof options !== "object" ||
      typeof options.moduleId !== "string" || options.moduleId.trim().length === 0) {
    throw new TypeError("A fixed module identity is required for the memory gateway.");
  }
  // Capture dependencies once so later mutation of the options object cannot
  // replace the storage, policy, or audit boundary after middleware creation.
  const moduleId = options.moduleId;
  const store = options.store;
  const policy = options.policy;
  const audit = options.audit;
  if (!store || !policy || !audit) {
    throw new TypeError("Persistent memory, policy, and durable audit dependencies are required.");
  }

  return (request: Request, response: Response, next) => {
    let principal;
    try {
      principal = getAuthenticatedPrincipal(request);
    } catch {
      // A malformed or unavailable upstream authentication context must fail closed.
      response.status(503).json({ error: "memory_unavailable" });
      return;
    }
    if (!principal) {
      response.status(401).json({ error: "unauthorized" });
      return;
    }

    let session: GuardedMemoryPort;
    try {
      session = createAuthenticatedMemorySession({
        principal,
        moduleId,
        store,
        policy,
        audit
      });
      if (!(session instanceof GuardedMemoryPort) || session.scopeModuleId !== moduleId) {
        throw new TypeError("Invalid request memory capability.");
      }
    } catch {
      // Session composition failures never fall back to raw storage or disclose internals.
      response.status(503).json({ error: "memory_unavailable" });
      return;
    }

    requestSessions.set(response, session);
    // Keep downstream Express errors under Express's normal error-handling path.
    next();
  };
}

/** Retrieve only the capability created for this response by the gateway. */
export function getAuthenticatedMemorySession(
  response: Response
): GuardedMemoryPort | null {
  return requestSessions.get(response) ?? null;
}
