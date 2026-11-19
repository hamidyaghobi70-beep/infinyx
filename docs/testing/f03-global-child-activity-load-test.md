# F-03 Global Child Activity Budget — Load-Test Specification

- Document ID: INFINYX-TEST-F03-LOAD-001
- Status: **Design only — execution not authorized by this document**
- Target implementation: `3491ac7c6ad5676faf792b5908043a4ef50778cc`
- Parent baseline: `7940c8d09277e3d9748d50234f3e3c8e4dacd0e7`
- Scope: `ProtectedOperationExecutor` global pending-child reservation budget
- Current limit: `MAX_GLOBAL_PENDING_CHILD_ACTIVITIES = 4096` (experimental)

## 1. Purpose

Define a reproducible, non-production load-test plan to evaluate the resource and latency characteristics of the F-03 global child-activity cap before any decision to promote 4096 from an experimental limit to an operationally accepted value.

This plan does not change runtime code, unit tests, CI workflows, the default branch, PR #53, or deployment configuration. It does not authorize running the load test.

## 2. Accepted architecture boundary

The counter is module-scoped and shared by all `ProtectedOperationExecutor` instances using the same loaded module instance in one JavaScript Runtime.

The guarantee does **not** extend across Worker Threads, independent Child Processes, or separately loaded module instances. The current load test must therefore exercise multiple Executor instances in one Runtime. It must not describe the result as a cross-process or whole-host resource limit.

The existing Child Process use for isolated Policy evaluation does not change this scope: the protected-operation Executor under test remains in the Core Runtime.

## 3. Fixed implementation constraints

The test must preserve and observe these existing limits and behaviors:

| Constraint | Value | Required observation |
|---|---:|---|
| Global pending child activities | 4096 | Never more than 4096 callbacks admitted and unsettled |
| Pending children per active handler | 1024 | A handler cannot reserve a 1025th child |
| Active protected handlers | 256 | The load profile must not exceed this admission ceiling |
| Child nesting depth | 64 | Existing depth protection remains effective |
| Reservation timing | Before callback invocation | An overflow callback is never invoked |
| Reservation release | Actual callback Promise settlement | Parent handler completion alone does not release a child slot |
| Release idempotency | Once per reservation | No double release or capacity undercount |
| Rejected admission | No queue / no automatic replay | Capacity recovery requires a new explicit request |

No test may bypass the public Executor API or mutate the module-level counter directly.

## 4. Test environment and isolation

Run only in a dedicated, non-production environment with no real external services, credentials, customer data, or production traffic.

Before an execution is authorized, record:

- Exact commit SHA and clean working-tree status
- OS and architecture
- CPU model and available logical CPU count
- Physical memory and available memory at start
- Exact Node.js version (Node.js 22+; record patch version)
- npm version and lockfile identity
- Vitest version and exact command/flags
- Process memory limits, if any
- Whether explicit garbage collection is enabled; if not, state that GC was observed naturally

Each independent scenario must start in a fresh Node.js process so unresolved work or module-level counter state cannot leak between scenarios. Within a scenario, create multiple Executor instances that import the same module instance.

Do not run the maximum-load profile in shared CI by default. A dedicated runner and an explicit resource budget must be approved first.

## 5. Workload profiles

Use a controlled Promise gate to keep child activities pending until the measurement phase ends. Use four or more independent Executor instances in the same Runtime; distribute child registrations evenly while respecting the 1024 per-handler ceiling.

| Profile | Intended pending children | Purpose |
|---|---:|---|
| P0 | 0 | Idle baseline and measurement overhead |
| P1 | 1024 | One-handler/local-cap boundary |
| P2 | 2048 | 50% global occupancy |
| P3 | 3072 | 75% global occupancy |
| P4 | 3686 (approximately 90%) | Near-capacity behavior |
| P5 | 4096 | Exact global-cap saturation |
| P6 | 4097 attempted | Verify overflow rejection without invoking callback |

For P5, use at least four Executor instances in the same Runtime, with no individual active handler registering more than 1024 pending children. Keep all admitted child Promises unresolved until the occupancy and resource measurements are captured.

For P6, attempt one additional child while P5 reservations remain pending. Assert that the additional callback invocation count remains zero and the attempt is rejected with the global child activity concurrency-limit error. Do not queue or automatically retry it.

## 6. Lifecycle and settlement scenarios

Measure and verify each scenario independently:

1. **Parent returns first:** parent handler returns while its children remain pending; all child reservations remain held and the parent execution remains tracked until actual settlement.
2. **Successful settlement:** resolve the pending gate; all reservations are released exactly once and all associated executions settle.
3. **Asynchronous rejection:** reject selected child Promises; verify failed outcomes and eventual capacity recovery.
4. **Synchronous callback throw:** throw from selected child callbacks; verify the reservation is released once and capacity is recoverable.
5. **Mixed settlement:** combine successful, rejected, and still-pending child Promises; confirm only actually settled children release slots.
6. **Repeated saturation cycles:** repeat fill → overflow → settle → refill in the same Runtime, while checking that the counter returns to the expected available capacity after each cycle.
7. **Local ceiling:** with one handler already holding 1024 children, verify its next child is rejected even when global capacity remains.
8. **Nesting boundary:** verify the existing depth-64 rule remains intact under a bounded load; do not use recursive unbounded generation.

The test harness must attach rejection observers to intentionally detached child Promises so the benchmark itself does not create unhandled-rejection noise.

## 7. Measurements

Capture time-series samples at idle, each ramp step, saturation, and after settlement.

### Resource measurements

- `process.memoryUsage()`: RSS, heapTotal, heapUsed, external, arrayBuffers
- Heap delta relative to P0 baseline and per admitted pending child
- Event-loop delay distribution using Node.js `perf_hooks` monitoring
- CPU utilization and process CPU time, where available
- Garbage-collection activity and pause observations, where available
- Peak memory during saturation and time to return toward the post-settlement baseline

Report both absolute values and deltas. Do not infer a memory leak from one post-GC sample or infer memory stability from RSS alone.

### Latency and throughput measurements

- Time to admit each workload profile
- Child registration latency distribution (p50, p95, p99, maximum)
- Overflow rejection latency
- Time from gate release to all child Promises settling
- Time to recover capacity for a subsequent explicit request
- Successful/rejected child settlement throughput
- Event-loop delay distribution during saturation and recovery

Use a monotonic clock. Report sample count and measurement method for every percentile. Separate warm-up from measured runs.

## 8. Repetition and reporting

For every profile:

- Perform a warm-up run that is excluded from reported measurements.
- Perform at least 5 measured repetitions in fresh processes.
- Preserve raw per-run measurements, not only averages.
- Report median and range across runs; include p50/p95/p99 for latency samples where sample counts support them.
- Record unexpected process exits, timeouts, unhandled rejections, and assertion failures as failures, not discarded outliers.

A run is invalid if the environment changes materially during measurement, if the harness fails to observe all expected settlements, or if the process is reused after an unresolved scenario.

## 9. Correctness gates

A performance result is not acceptable unless all correctness checks pass:

- Admitted pending child count never exceeds 4096.
- No individual handler exceeds 1024 pending children.
- Overflow callbacks are not invoked.
- Parent handler return does not release pending child reservations.
- Every reservation is released once, only after actual settlement.
- Sync throw and async rejection both recover capacity.
- No rejected admission is queued or automatically replayed.
- After all work settles, a new explicit request can use recovered capacity.
- No unhandled Promise rejection is emitted by the implementation or harness.
- No unrelated test, process-lifecycle, or shutdown regression is observed.

Any correctness failure stops the run; do not continue increasing load.

## 10. Operational acceptance is a separate decision

This specification intentionally defines no numeric pass threshold for memory, latency, CPU, or event-loop delay. Such thresholds must be set and approved by the architecture owner against a stated target environment and workload before execution. Choosing thresholds after seeing results would invalidate the acceptance decision.

The value 4096 remains **Experimental Limit** until:

1. the architecture owner approves the target environment and measurable SLO/resource budgets;
2. the controlled load test is authorized and executed;
3. raw results and environment metadata are retained;
4. an independent reviewer examines correctness and performance evidence; and
5. the architecture owner issues a separate written decision to retain, lower, or otherwise revise the limit.

Passing this test does not prove safety across Worker Threads, Child Processes, independent module instances, hosts, or distributed deployments.

## 11. Explicit non-goals and prohibitions

- No runtime source changes.
- No changes to existing unit tests or CI workflows as part of this specification.
- No Worker Thread, multi-process, or distributed-counter implementation.
- No production traffic, production credentials, or external side effects.
- No automatic retry of rejected child registrations.
- No change to PR #53 status or base branch.
- No merge, release, deployment, or change to `main`.

## 12. Execution authorization checklist

Execution remains blocked until all items are explicitly approved:

- [ ] Architecture owner approves target environment and resource budget.
- [ ] Architecture owner approves numeric memory, latency, CPU, and event-loop thresholds.
- [ ] Founder/authorized project governance approves a dedicated execution window if required.
- [ ] Independent reviewer agrees the harness measures the stated invariants.
- [ ] A separate test-only branch and isolated runner are confirmed.
- [ ] PR #53 and `main` remain untouched by the test run.

**Current disposition:** specification prepared; no load test executed; 4096 remains experimental; F-03 remains conditionally accepted and open.
