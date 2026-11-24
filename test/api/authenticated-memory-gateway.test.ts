import { afterEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

const { getPrincipal, createSession } = vi.hoisted(() => ({
  getPrincipal: vi.fn(),
  createSession: vi.fn()
}));
vi.mock("../../src/core/authenticated-principal.js", () => ({
  getAuthenticatedPrincipal: getPrincipal
}));
vi.mock("../../src/core/authenticated-memory-session.js", () => ({
  createAuthenticatedMemorySession: createSession
}));
vi.mock("../../src/core/guarded-memory-port.js", () => ({
  GuardedMemoryPort: class GuardedMemoryPort {
    constructor(readonly scopeModuleId: string) {}
  }
}));

import {
  createAuthenticatedMemoryGateway,
  getAuthenticatedMemorySession
} from "../../src/api/authenticated-memory-gateway.js";
import { GuardedMemoryPort } from "../../src/core/guarded-memory-port.js";

function harness() {
  const response = {
    locals: {},
    status: vi.fn(function(this: unknown) { return this; }),
    json: vi.fn()
  } as unknown as Response;
  const next = vi.fn();
  return { response, next };
}

afterEach(() => vi.resetAllMocks());

describe("request-scoped authenticated memory gateway", () => {
  const dependencies = {
    moduleId: "notes",
    store: { read: vi.fn(), write: vi.fn(), delete: vi.fn() },
    policy: { evaluate: vi.fn() },
    audit: { publishDecision: vi.fn(), publishFailure: vi.fn() }
  };

  it("creates and exposes a guarded session only for a verified principal", () => {
    const principal = Object.freeze({ subject: "actor", tenantId: "tenant", issuer: "issuer", audience: ["api"], expiresAt: 9_999_999_999 });
    const session = new GuardedMemoryPort("notes");
    getPrincipal.mockReturnValue(principal);
    createSession.mockReturnValue(session);
    const { response, next } = harness();

    createAuthenticatedMemoryGateway(dependencies)(
      { res: response } as Request, response, next
    );

    expect(createSession).toHaveBeenCalledWith({
      principal, moduleId: "notes", store: dependencies.store,
      policy: dependencies.policy, audit: dependencies.audit
    });
    expect(getAuthenticatedMemorySession(response)).toBe(session);
    expect(next).toHaveBeenCalledOnce();
  });

  it("rejects unauthenticated requests without constructing a session", () => {
    getPrincipal.mockReturnValue(null);
    const { response, next } = harness();

    createAuthenticatedMemoryGateway(dependencies)(
      { res: response } as Request, response, next
    );

    expect(response.status).toHaveBeenCalledWith(401);
    expect(createSession).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it("fails closed when session construction fails and hides dependency errors", () => {
    getPrincipal.mockReturnValue({ subject: "verified" });
    createSession.mockImplementation(() => { throw new Error("KMS credential detail"); });
    const { response, next } = harness();

    createAuthenticatedMemoryGateway(dependencies)(
      { res: response } as Request, response, next
    );

    expect(response.status).toHaveBeenCalledWith(503);
    expect(response.json).toHaveBeenCalledWith({ error: "memory_unavailable" });
    expect(next).not.toHaveBeenCalled();
  });

  it("does not accept a capability injected through mutable response.locals", () => {
    const { response } = harness();
    response.locals.authenticatedMemorySession = new GuardedMemoryPort("notes");
    expect(getAuthenticatedMemorySession(response)).toBeNull();
  });

  it("keeps capabilities isolated to the response that created each request session", () => {
    const principal = Object.freeze({ subject: "actor", tenantId: "tenant", issuer: "issuer", audience: ["api"], expiresAt: 9_999_999_999 });
    const firstSession = new GuardedMemoryPort("notes");
    const secondSession = new GuardedMemoryPort("notes");
    getPrincipal.mockReturnValue(principal);
    createSession.mockReturnValueOnce(firstSession).mockReturnValueOnce(secondSession);
    const first = harness();
    const second = harness();
    const gateway = createAuthenticatedMemoryGateway(dependencies);

    gateway({ res: first.response } as Request, first.response, first.next);
    gateway({ res: second.response } as Request, second.response, second.next);

    expect(getAuthenticatedMemorySession(first.response)).toBe(firstSession);
    expect(getAuthenticatedMemorySession(second.response)).toBe(secondSession);
    expect(getAuthenticatedMemorySession({ locals: {} } as Response)).toBeNull();
    expect(first.next).toHaveBeenCalledOnce();
    expect(second.next).toHaveBeenCalledOnce();
  });
});
