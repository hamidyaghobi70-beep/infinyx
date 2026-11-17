# Issue #29 — Windows Job Object Launcher IPC Proof of Concept

Status: **EXPERIMENTAL POC — NOT PRODUCTION-INTEGRATED / NOT SECURITY-APPROVED**

## Scope

This change tests one narrow prerequisite from the Windows launcher design: whether a native launcher can inherit the Node.js IPC endpoint supplied by a Node parent and pass that same endpoint to an evaluator Node process without parsing or reimplementing Node's private IPC framing.

It does not change `ProcessIsolatedPolicyEngine`, its Windows capability label, or production authorization behavior. Windows continues to report `DIRECT_CHILD_ONLY`.

## Native launcher behavior

`native/windows/job-launcher-poc.c` is an in-repository C executable built with the Visual Studio C toolchain in Windows CI. It:

1. Reads `NODE_CHANNEL_FD` and resolves the corresponding CRT descriptor to a Windows handle using `_get_osfhandle`. If the descriptor is absent or invalid, it fails closed.
2. Creates an unnamed Job Object and sets only `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`; it does not enable either breakaway flag.
3. Builds an explicit inherited-handle allow-list containing the standard I/O handles and the IPC handle.
4. Creates the evaluator Node process suspended with `PROC_THREAD_ATTRIBUTE_JOB_LIST`, associating it with the Job during process creation. It resumes the evaluator only after successful creation.
5. Waits for the evaluator and then for the Job Object active-process count to reach zero before returning.

The Job handle is not included in the inherited-handle allow-list. The launcher remains the owner of that handle. Any setup or process-creation failure returns a nonzero status; there is no direct-child fallback.

## Executable IPC/stdio proof

The Windows-only Node test checks the following message directions through the unchanged IPC channel:

- Parent to evaluator: `evaluate`, `cancel`, and `finalize`.
- Evaluator to parent: `started`, `cancelled`, and `finalized`.

It also checks that stdout and stderr remain separately observable. The fixture deliberately waits for cancellation and finalization so the test covers more than a one-way startup message.

The test is run only on Windows after CI compiles the C source with MSVC. On non-Windows platforms it is skipped; a skipped test is not evidence of IPC compatibility.

## Explicitly not proven by this POC

- No production engine integration or capability upgrade.
- No descendant-spawn/termination or launcher-crash fault-injection test yet.
- No exhaustive validation of handle inheritance, Job accounting races, resume failure, or incompatible outer Job behavior.
- No proof of the narrow interrupted-`CreateProcessW` crash window described in the design proposal.
- No filesystem, network, credential, kernel, or general sandbox isolation.
- No independent security review.

If the Windows IPC test fails, do not work around it by parsing Node's private IPC protocol or moving control messages onto stdout/stderr. Stop and design a separately reviewed transport.

## CI

The Windows matrix job compiles the native source and runs `npm run test:windows-launcher-poc`. The exact workflow run and tested commit SHA must be recorded before claiming the IPC proof passed.

## References

See [Windows Job Object Launcher Design](./ISSUE-29-WINDOWS-JOB-LAUNCHER-DESIGN.md) for the full acceptance gates and Microsoft API references.
