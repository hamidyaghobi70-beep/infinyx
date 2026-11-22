# Linux Broker Protocol v1 — implementation checkpoint

**Status: protocol library foundation only. Broker daemon and containment are NOT implemented.**

This checkpoint adds a Rust library for a bounded, versioned Unix-socket wire format, Linux kernel peer-credential retrieval, and a read-only cgroup v2 preflight command. It intentionally performs no privileged operation and must not be installed as a broker or connected to the Core Engine.

## Wire framing

Each message is a 4-byte unsigned big-endian length followed by UTF-8 JSON. The payload must be between 1 and 65,536 bytes. The receiver checks the bound before allocating the payload. Each request carries protocol version 1, a bounded opaque request ID, and one tagged operation.

Supported operation names in the schema:

- `LAUNCH_TRUSTED_RUNNER` — no caller-selected executable, arguments, environment, or path.
- `RUNNER_SEND`
- `TERMINATE_BOUNDARY`
- `WAIT_BOUNDARY_EMPTY` — bounded timeout.
- `RELEASE_BOUNDARY`
- `QUERY_STATUS`

The schema is not an authorization grant. Every operation must be bound to the authenticated socket peer and broker-owned containment state. Strict decoding rejects unknown request fields; authorization compares the kernel-reported peer UID with one administrator-configured UID.

## Identity

On Linux, the library reads `SO_PEERCRED` from the connected Unix socket. A daemon must compare the returned UID against an administrator-configured allowlist before parsing or acting on requests. Identity fields in JSON are never authoritative. Non-Linux builds return an unsupported error.

## Read-only host preflight

Run `cargo run --manifest-path native/linux-cgroup-broker/Cargo.toml --bin infinyx-cgroup-preflight -- /sys/fs/cgroup` on Linux. The command reports the filesystem type, controller files, populated observation, presence of cgroup control files, and effective-credential write-access checks. It does not write to the cgroup filesystem. Its `broker_activation_eligible` field is deliberately always `false`: a filesystem probe cannot establish safe delegation, evaluator identity separation, migration resistance, or process-tree containment.

Ubuntu CI runs this preflight against the hosted runner's cgroup root as a read-only diagnostic. Passing the command proves only that the probe compiled and ran and that the inspected path is cgroup v2; it does not make the hosted runner a suitable privileged integration host.

## Deliberate omissions / remaining gates

This commit does **not** include:

- a listening daemon or socket lifecycle/permissions;
- peer-UID policy configuration;
- durable allocation metadata or crash recovery;
- cgroup subtree validation, creation, resource controls, or ownership;
- gated bootstrap launch, runner relay, or process assignment;
- `cgroup.kill` termination and independent `cgroup.events` empty proof;
- a Node socket client or Core Engine integration;
- privileged Linux integration tests.

Until those pieces and the real-host acceptance suite are complete, the broker remains **HOLD**. No production activation, merge, release, deployment, or cloud resource creation is authorized by this checkpoint.
