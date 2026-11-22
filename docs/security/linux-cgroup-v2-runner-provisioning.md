# Linux cgroup v2 Integration Runner Provisioning

**Status:** operator prerequisite checklist. This document does not provision a host, grant privileges, install a broker, or establish containment.

## Purpose

The ordinary GitHub-hosted Ubuntu runner used by the current CI workflow is not a delegated cgroup v2 environment. A separate, disposable Linux runner is required before privileged containment integration tests can be meaningful.

## Required operator-provisioned properties

An administrator must provision and document all of the following on a dedicated, disposable runner:

1. A supported Linux kernel with a unified cgroup v2 hierarchy and the kernel facilities required by the broker implementation.
2. A dedicated cgroup subtree delegated exclusively to the broker service. Do not delegate the hierarchy root or a subtree shared with unrelated workloads.
3. A dedicated broker OS identity with only the permissions required to manage that subtree.
4. A distinct unprivileged application identity and evaluator identity. The evaluator must not be able to modify the delegated root, ancestor migration controls, boundary cgroup.procs, or boundary cgroup.kill.
5. A broker-owned Unix socket directory with restrictive filesystem permissions and kernel peer-credential authentication.
6. A fixed, administrator-owned trusted bootstrap artifact and a minimal environment allowlist. No request-controlled executable, path, environment, or working directory.
7. Resource ceilings and a cleanup/reconciliation policy for interrupted jobs and broker restarts.
8. A disposable host or VM snapshot so destructive lifecycle tests cannot affect shared workloads.

## Preflight evidence (must be collected as the actual service identities)

Before enabling any integration test, the runner setup must record and verify:

- Kernel release and unified cgroup mount.
- Exact delegated subtree path and its owner/group/mode.
- Required controller availability in the delegated subtree.
- Read/write access for the broker identity to only the intended subtree.
- Denied write/migration access for the evaluator identity to the delegated root and its ancestors.
- Ability to observe boundary population state and use boundary-wide termination.
- Successful cleanup and empty-state verification after a harmless fixture run.

A root-level check of /sys/fs/cgroup writability is not an acceptance test for delegation. The check must target the exact delegated subtree and use the actual broker/evaluator identities. Never infer delegation from the mere presence of cgroup.controllers.

## GitHub Actions integration policy

- Keep the standard ubuntu-latest, macOS, and Windows matrix unprivileged and suitable for build/unit tests.
- Add privileged integration jobs only after the runner is provisioned and reviewed.
- Pin the privileged job to an explicit self-hosted label reserved for disposable INFINYX containment runners; do not let ordinary pull-request code run on a persistent privileged host.
- Restrict which repositories, branches, and administrators can use the runner. Prefer an ephemeral runner that is destroyed after each job.
- Do not expose deployment credentials or production secrets to pull-request workflows.
- The privileged job must fail closed when preflight evidence is absent or any permission assertion fails. It must never fall back to direct-child signaling or process groups.
- Keep privileged integration results distinct from mocked adapter tests and the ordinary CI matrix.

## Activation gate

Do not register or target a self-hosted runner from repository workflows until an administrator has actually provisioned it and reviewed its isolation, access policy, lifecycle, and cleanup. A workflow definition alone is not evidence that such a runner exists.

The Linux broker remains unimplemented until the native broker, Node transport, engine integration, and real privileged tests pass together. Production custom evaluators must remain default-deny until the full acceptance gate is met.
