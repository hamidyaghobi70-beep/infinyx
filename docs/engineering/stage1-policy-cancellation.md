# INFINYX-ENG-001 — Stage 1 Policy Cancellation Hardening

**Status:** Proposed engineering specification (documentation only)  
**Stage:** Stage 1 — Policy Cancellation Hardening  
**Applies to:** Core Platform lifecycle contracts and future policy-governed execution workflows  
**Repository:** `hamidyaghobi70-beep/infinyx`  
**Baseline:** `2aab78817b50f48a4c8125b426e3b3d5bedaba44`

## 1. Purpose

Define the minimum safe, deterministic contract for cancelling work when a policy decision, caller request, deadline, or application shutdown requires execution to stop. This document specifies intended behavior; it does not claim that cancellation infrastructure is currently implemented.

The design follows the approved modular-monolith architecture. Cancellation is a cross-cutting lifecycle concern owned by the Core Platform, while policy decisions remain owned by the Security Layer. Callers depend on explicit contracts rather than module internals.

## 2. Scope and non-goals

### In scope

- A consistent cancellation vocabulary and terminal outcome.
- Propagation of cancellation through nested application work.
- Precedence between policy denial, cancellation, deadlines, and normal completion.
- Idempotency, race handling, and cleanup expectations.
- Safe interaction with process shutdown.
- Auditable outcomes and future verification requirements.

### Out of scope

- Implementing or enabling Agent Runtime, Agent Orchestrator, Tool Gateway, or Automation Engine.
- Introducing a message broker, database, distributed cancellation service, or new persistence layer.
- Defining authentication, tenant identity, or policy authoring syntax.
- Enabling external side effects, tool execution, blockchain writes, transaction signing, or asset transfers.
- Changing runtime code, dependencies, configuration, CI, or deployment topology in this stage.

## 3. Design principles

1. **Default deny:** A missing, invalid, stale, or indeterminate policy decision must not authorize protected work.
2. **Cancellation is cooperative:** A cancellation signal requests work to stop; it is not proof that every operation has already stopped.
3. **Fail closed at protected boundaries:** No new protected side effect may begin after cancellation has been observed or authorization has ceased to be valid.
4. **One-way terminal state:** Once a work item is terminal, it cannot return to a running state.
5. **No hidden bypass:** Nested modules and adapters must not suppress, replace, or detach the governing cancellation context.
6. **Explicit ownership:** Core Platform owns lifecycle/cancellation primitives; Security Layer owns authorization decisions; domain modules own their work and cleanup.
7. **No false success:** A cancelled or policy-denied operation must never be reported as successful completion.

## 4. Terminology and outcomes

- **Cancellation request:** A signal from an authorized caller, deadline, policy enforcement point, or shutdown coordinator asking a work item to stop.
- **Cancellation context:** The execution-scoped signal and metadata propagated to child operations.
- **Policy denial:** A decision that the requested action is not authorized. It is distinct from cancellation.
- **Deadline exceeded:** A time-bound execution limit has elapsed. It is a cancellation cause, not a successful result.
- **Terminal outcome:** The immutable final classification of a work item.

The externally observable terminal outcomes should distinguish at least:

| Outcome | Meaning |
|---|---|
| `completed` | Work completed successfully before a stopping condition took effect. |
| `cancelled` | Work stopped in response to a cancellation request. |
| `denied` | Policy did not authorize the operation. |
| `timed_out` | The applicable deadline elapsed before completion. |
| `failed` | Work failed for an operational reason unrelated to an authorized stop. |

Implementations may carry a structured reason code and safe diagnostic metadata. They must not expose secrets, credentials, or sensitive payloads in outcomes or logs.

## 5. Required lifecycle contract

A future implementation must model each cancellable work item as moving through the following logical states:

`created → authorized → running → (completed | cancelled | denied | timed_out | failed)`

- Authorization must be checked before protected execution begins.
- A work item that is denied must not enter the running state.
- Cancellation may be requested while work is created, authorized, or running. The request must be recorded and honored before any subsequent protected operation.
- Terminal transitions must be atomic and immutable.
- Repeated cancellation requests must be safe and idempotent. They must not create multiple terminal outcomes or duplicate cleanup.
- A late cancellation request must not rewrite an already committed terminal outcome. The system may record that the request arrived late for diagnostic purposes.
- A race between completion and cancellation must have one deterministic winner at the state-transition boundary. The implementation must not report both outcomes.

## 6. Policy and cancellation precedence

The following rules are normative:

1. **Policy denial wins over execution.** If authorization is denied or cannot be established, protected work does not start.
2. **Authorization is not permanent by implication.** If a policy requires revalidation, the relevant boundary must re-check it before proceeding.
3. **Observed cancellation blocks further work.** Once the cancellation context is observed, the current operation must stop at the earliest safe point and must not begin another protected side effect.
4. **Deadline expiry is terminal for the governed attempt.** Work must not continue as though its deadline were extended. Any retry requires a new, explicitly authorized attempt and a new applicable deadline.
5. **Shutdown is a cancellation source, not an authorization grant.** Process shutdown must not cause new work to be admitted or bypass policy checks.
6. **No implicit resume.** Cancelled work cannot resume in place. A retry is a new work item with fresh policy evaluation and its own correlation identity.

If policy revocation and cancellation race, the system must prevent any new protected side effect unless authorization is affirmatively valid at the relevant enforcement boundary. The final recorded reason must follow a documented, deterministic classification rule; the implementation must preserve enough internal evidence to distinguish denial from cancellation.

## 7. Propagation and module boundaries

- The Core Platform should provide a framework-neutral cancellation contract, suitable for propagation through application interfaces.
- In a TypeScript implementation, an `AbortSignal`-compatible mechanism is an acceptable implementation choice, but this specification does not mandate a particular library or public API shape.
- Each child operation must receive the governing cancellation context or an explicitly derived child context.
- A child operation must not replace a parent cancellation signal with an unrelated signal or silently detach from it.
- Adapters for network, timer, stream, or other asynchronous work must document whether cancellation is immediate, cooperative, or unsupported.
- Unsupported cancellation must be explicit. It must not be represented as successful cancellation.
- Transport-specific request objects must remain at the API boundary; internal module contracts must not depend on Express request/response types.
- Cancellation propagation must remain within the modular-monolith contract boundaries and must not introduce direct access to another module's private implementation.

## 8. Side effects, cleanup, and consistency

- Check cancellation immediately before starting each protected side effect, not only when a workflow first starts.
- Do not assume that cancellation rolls back an already completed external side effect.
- Operations that cannot be safely interrupted must declare that limitation and define a bounded completion or reconciliation behavior before they are enabled.
- Cleanup must be best-effort, bounded, and safe to repeat. Cleanup failure must not convert a cancelled operation into a successful one.
- Preserve the primary terminal outcome while recording cleanup failures separately.
- Do not automatically retry a cancelled, denied, or timed-out side effect. Any retry must be explicitly designed for idempotency and reauthorization.
- No cancellation path may bypass human approval for sensitive actions.

## 9. Process shutdown interaction

The shutdown coordinator must use the same lifecycle contract rather than inventing a separate cancellation meaning.

1. Stop admitting new work when shutdown begins.
2. Signal active cancellable work to stop and propagate the signal to child operations.
3. Allow a bounded, configured grace period for cooperative cancellation and cleanup.
4. At the end of the grace period, record work that did not stop; do not claim that it completed or was cancelled cleanly.
5. Close owned resources in a deterministic order and prevent new resource acquisition during teardown.
6. Keep shutdown idempotent: repeated shutdown signals must not restart teardown or reopen admission.
7. Do not make a successful process-liveness response imply that business work, dependencies, or graceful shutdown are healthy.

The grace-period value, signal handling details, and resource ordering require implementation-specific decisions and review; this document does not introduce configuration values.

## 10. Observability and audit requirements

When observability is implemented, record structured lifecycle events sufficient to reconstruct the decision without recording sensitive payloads. At minimum, the event model should support:

- Work/correlation identifier and parent correlation identifier, where applicable.
- Lifecycle transition and terminal outcome.
- Cancellation source and a bounded, non-sensitive reason code.
- Policy decision reference or version where available, without embedding policy secrets.
- Event timestamp and elapsed duration.
- Whether cleanup completed, failed, or exceeded its bound.

Logs must follow the repository security baseline and Pino redaction requirements. Durable audit storage is not part of the current foundation and must not be implied by ordinary application logs.

## 11. Verification and acceptance criteria

A future implementation is not accepted solely because it exposes a cancellation method. Verification must demonstrate:

- Denied and indeterminate policy decisions prevent protected work from starting.
- Cancellation propagates from a parent operation to nested child work.
- Repeated cancellation is idempotent.
- Completion-versus-cancellation races produce exactly one terminal outcome.
- Cancellation observed before a protected side effect prevents that side effect from starting.
- An already completed side effect is not falsely described as rolled back.
- Deadline expiry stops the governed attempt and does not silently extend it.
- Shutdown stops admission, signals active work, observes a bounded grace period, and does not report unconfirmed work as cleanly stopped.
- Cleanup is bounded and repeat-safe; cleanup errors do not erase the primary outcome.
- Logs and outcomes do not disclose credentials, tokens, secrets, or sensitive payloads.
- Module boundaries remain intact and no deferred agent/tool capability becomes enabled as a side effect of this work.

Tests should cover normal flow, error flow, cancellation before start, cancellation during work, late cancellation, nested propagation, repeated signals, and concurrent terminal transitions. These are future implementation acceptance criteria, not tests run in this documentation-only stage.

## 12. Stage 1 deliverables and restrictions

This stage records the contract only. No runtime behavior is asserted to have changed.

- [x] Create an isolated documentation branch from the specified baseline commit.
- [x] Add this engineering specification.
- [ ] Implement cancellation primitives or lifecycle changes — deferred.
- [ ] Add or change source-code tests — deferred.
- [ ] Change configuration, dependencies, CI, or deployment settings — out of scope.
- [ ] Merge, release, or deploy — not authorized by this stage.

## 13. Open implementation decisions

The following must be resolved and documented before implementation:

- Which Core Platform interface owns work-item state and terminal transition arbitration?
- Which cancellation sources are authorized for each class of work?
- What are the default and maximum shutdown grace periods, and who may configure them?
- Which operations are safely interruptible, and which require compensation or reconciliation?
- What policy revalidation points are required for each protected operation?
- What audit retention and access controls are required before durable audit storage is introduced?

Until these decisions are resolved, this document must be treated as a proposed contract and must not be interpreted as evidence that cancellation or policy enforcement is implemented.

## 14. Related repository policy

This specification supplements, and does not override:

- `docs/architecture/overview.md`
- `docs/architecture/module-boundaries.md`
- `docs/security/security-baseline.md`
- `docs/governance/merge-authority.md`

More restrictive security controls, repository protections, and explicit approval requirements continue to apply.
