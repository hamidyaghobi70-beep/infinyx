# INFINYX Cloud Linux Containment Test Node — Execution Plan

**Status:** design and operator runbook draft. This document does not create cloud resources, provision a VM, register a runner, install a broker, or enable evaluator execution.

**Target:** disposable cloud-hosted Linux test environment only. It is not production infrastructure.

## 1. Decisions and non-goals

- Hosting: cloud VM in a private network.
- Purpose: development and privileged integration testing.
- Initial shape: one disposable Linux VM/runner at a time; rebuild from a reviewed image rather than treating it as a long-lived server.
- Keep ordinary GitHub-hosted CI for build, typecheck, unit tests, macOS/Windows checks, and dependency audit.
- Do not run untrusted pull-request code on a persistent privileged self-hosted runner.
- Do not expose production credentials, deployment credentials, customer data, or reusable cloud administrator credentials to the test VM.
- Do not merge PR #57, change its base, release, deploy, or activate custom evaluators as part of provisioning.
- This node is process-tree containment test infrastructure, not a complete sandbox. Filesystem, network, syscall, credential, and artifact isolation need separate controls.

## 2. Initial VM profile

| Item | Initial target | Notes |
|---|---|---|
| Image | Ubuntu Server 24.04 LTS, x86_64 | Use a current provider-supported image with security updates |
| CPU | 8 vCPU | Test baseline; tune from measured load |
| Memory | 16 GiB | Avoid memory overcommit for repeatable tests |
| OS disk | 100 GiB encrypted SSD | Prefer disposable boot/data volume |
| Network | Private subnet, no public inbound services | No public IP unless provider requires a controlled runner registration path |
| Admin access | Provider session manager or tightly restricted SSH | Short-lived identity; no shared password |
| Runtime | systemd, unified cgroup v2 | Verify on the actual image/kernel |
| Lifecycle | Ephemeral/rebuildable | Destroy or revert after each test campaign |
| Region | Select near project operators and compliant with data policy | No region selected yet |

Do not scale up before measuring concurrency, test duration, and resource pressure. Use a separate production design review before reusing any component for production.

## 3. Cloud control-plane layout

Create the following provider resources using the provider's native infrastructure-as-code system after the provider and account are selected:

1. A dedicated project/account or isolated resource group for INFINYX test infrastructure.
2. A private VPC/VNet and private subnet for the test node.
3. A security group/firewall with inbound deny by default.
4. An outbound policy that allows only required package/image repositories, GitHub runner control-plane endpoints, time synchronization, and approved logging endpoints. Document any provider-required exceptions.
5. An encrypted VM disk and encrypted log storage.
6. A narrowly scoped instance identity for pulling approved artifacts and publishing test logs; no broad account administration.
7. A short-retention log sink for OS, runner, and broker diagnostics. Never log evaluator secrets or full sensitive request payloads.
8. A disposable VM image or snapshot pipeline with patching and rebuild instructions.

Do not place the broker socket on a network interface. Broker IPC remains a local Unix-domain socket.

## 4. Host trust boundaries

Use distinct OS identities:

- `infinyx-broker`: owns the broker service and only the delegated cgroup subtree.
- `infinyx-app`: unprivileged application/runner client.
- `infinyx-evaluator`: unprivileged evaluator identity with no broker socket or cgroup control access.
- A separate administrative identity for host maintenance; never use it to run evaluators.

Required host properties:

- Unified cgroup v2 hierarchy.
- A dedicated subtree delegated exclusively to the broker; do not delegate the hierarchy root or a subtree shared with unrelated workloads.
- Broker-owned directories and socket with restrictive ownership/modes.
- Evaluator cannot write ancestor migration controls, broker-owned `cgroup.procs`, `cgroup.kill`, or broker socket.
- Broker authenticates local peers using kernel peer credentials and validates the actual peer identity; never trust a UID/PID supplied in a request.
- Fixed administrator-owned trusted bootstrap artifact; no caller-selected executable, library, working directory, cgroup path, or arbitrary environment.
- Minimal environment allowlist; no inherited cloud credentials, GitHub tokens, SSH agent, or operator secrets.
- Resource ceilings for memory, CPU, process count, wall-clock duration, message size, concurrency, and allocation lifetime.
- Broker startup and each launch fail closed if any required kernel facility, permission, controller, or read-back check is missing.

The exact delegated path, owner/group/mode, controller set, and permission checks must be recorded using the actual broker, application, and evaluator identities. Presence of `cgroup.controllers` alone is not evidence of usable delegation.

## 5. Runner and GitHub Actions policy

Preferred initial operation is a manually dispatched, narrowly authorized privileged workflow on an ephemeral runner that is destroyed after the job.

Before connecting GitHub Actions:

- Create a dedicated runner group restricted to the INFINYX repository and explicitly approved administrators.
- Use a unique self-hosted label reserved for disposable containment test nodes.
- Do not allow general pull-request workflows or fork-originated code to schedule on this runner.
- Require a trusted, reviewed branch/ref and manual approval for the privileged job.
- Keep privileged workflow definition and broker integration tests behind a separate workflow boundary from the ordinary PR matrix.
- Give the runner only the minimum GitHub permissions required; contents read by default.
- Do not expose deployment secrets or production credentials.
- Rebuild the VM/runner after every privileged job, or destroy it and create a fresh ephemeral instance.
- Preserve only sanitized test results and audit logs; do not preserve evaluator workspaces or credentials.
- Keep ordinary Ubuntu/macOS/Windows CI unprivileged and separate from privileged Linux containment evidence.

Do not add a workflow targeting a self-hosted label until the runner is actually provisioned, access policy is reviewed, and an operator confirms the label/group exists. A workflow file is not proof that a runner exists.

## 6. Provisioning sequence and gates

### Gate A — provider and account selection

Operator records:
- Cloud provider and account/project owner.
- Region and data residency constraints.
- Billing owner and budget ceiling.
- Who can create, start, stop, inspect, and destroy the VM.
- Provider-supported private access and ephemeral runner options.

No cloud resources are created before this gate.

### Gate B — isolated cloud foundation

Provision the isolated project/resource group, private network, firewall, encrypted storage, instance identity, logging, and disposable VM image. Review inbound/outbound rules and cost controls.

Acceptance evidence:
- No public inbound access to the node.
- No production account or secret attached.
- VM can be destroyed and recreated from documented configuration.
- Admin access is attributable and auditable.

### Gate C — OS and cgroup preflight

Install and patch the selected Ubuntu image. Verify kernel release, unified cgroup mount, required controllers, exact delegated subtree, ownership/mode, and read/write/deny permissions as the real service identities.

Acceptance evidence:
- Broker can manage only its assigned subtree.
- Evaluator cannot migrate to ancestors or modify broker-owned boundary controls.
- A harmless fixture can be placed in a boundary and the kernel-reported empty state can be observed after termination.
- Failed permission or kernel checks prevent service startup/launch.

Do not install or activate the broker until its implementation and service packaging have passed code review.

### Gate D — runner registration

Register an ephemeral runner with a dedicated runner group/label and the restricted workflow policy above. Verify a no-secret diagnostic job, then destroy and recreate the runner to prove lifecycle behavior.

Acceptance evidence:
- Only authorized workflow/ref can schedule.
- Runner is not available to arbitrary pull requests or forks.
- Runner is destroyed/reimaged after the job.
- No privileged token or cloud administrator credential is exposed to job steps.

### Gate E — broker implementation and deployment

Implement and review the native broker, versioned bounded Unix-socket protocol, peer authentication, fixed trusted bootstrap, cgroup lifecycle, resource controls, crash recovery, and Node adapter. Keep production factory default-deny.

Launch ordering must guarantee that only a trusted gated bootstrap starts before cgroup membership is established and verified; evaluator code is imported only after a valid broker attestation and explicit evaluate message.

### Gate F — privileged integration evidence

Run on the disposable cloud runner using actual service identities:

- Pre-import gate: evaluator code cannot load before containment attestation.
- Descendant cleanup: direct runner exit does not release capacity until the complete boundary is proven empty.
- Escape resistance: evaluator cannot migrate to ancestors or modify supervisor-owned controls.
- Boundary isolation: one execution cannot inspect, signal, or release another.
- Failure injection: cgroup creation, assignment, relay, termination, empty-state read, release, and broker restart failures retain ownership and capacity until proof.
- Resource ceilings and concurrency limits are enforced.
- Control-channel loss does not orphan active boundaries.
- Unsupported kernel/permissions fail closed with no direct-child or process-group fallback.

Record exact commit SHA, runner image/kernel, test identity model, and sanitized logs for each run. Mock tests remain useful but are not counted as privileged containment evidence.

### Gate G — review and closure

Security review confirms the evidence and remaining limitations. Only a separate explicit decision can authorize any later production work. This test-node plan itself authorizes no merge, release, deployment, or production activation.

## 7. Operations and teardown

- Apply security updates through a controlled image rebuild process.
- Restrict and audit administrative access.
- Alert on unexpected inbound access, broker crash loops, unreconciled cgroups, resource exhaustion, and runner lifecycle failures.
- Retain sanitized audit evidence according to a documented short retention period.
- Destroy the VM after test campaigns; delete temporary disks, runner registrations, ephemeral credentials, and transient artifacts.
- Verify cloud inventory and billing after teardown.
- If broker cleanup cannot prove a boundary empty, quarantine and preserve the disposable host for investigation; do not silently recycle it.

## 8. Cost and ownership controls

The provider and region are not selected, so no price estimate is asserted. Set a monthly budget cap and automatic shutdown/expiry policy before provisioning. Use on-demand compute for initial tests; consider spot/preemptible capacity only after interruption recovery is tested and never as a substitute for cleanup correctness.

## 9. Current status

- Cloud hosting and test-only purpose are selected.
- Provider, account/project, region, billing owner, and operator identities remain undecided.
- No VM, network, runner, broker, or cloud resource has been created by this plan.
- GitHub-hosted Ubuntu CI remains read-only with respect to cgroups and is not a privileged containment runner.
- Production custom evaluators remain default-deny.
