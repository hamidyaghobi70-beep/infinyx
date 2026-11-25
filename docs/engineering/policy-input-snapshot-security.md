# Policy Input Snapshot: Security Boundary and Limitations

**Status:** Engineering constraint for the bounded policy-input snapshot  
**Applies to:** `snapshotBoundedPolicyData` and its callers

## Guarantees for ordinary data objects

The snapshot routine accepts supported primitive values, arrays, and plain records, then returns a detached, deeply frozen copy. It enforces:

- Maximum depth: 32.
- Maximum visited nodes: 10,000.
- Maximum UTF-8 bytes per string or key: 16 KiB.
- Maximum aggregate UTF-8 bytes: 256 KiB.
- Maximum entries per container: 1,000.
- Rejection of cycles, accessors, hidden properties, symbol keys, sparse arrays, exotic prototypes, and non-finite numbers.

UTF-8 byte length is measured with Node.js `Buffer.byteLength(value, "utf8")`; the implementation does not create a second encoded byte array just to measure a string.

## Same-process Proxy limitation

This function is a bounded data snapshot, not a sandbox or a hostile-object isolation boundary.

JavaScript reflection on a Proxy can execute user-defined traps. Prototype inspection, own-key enumeration, and property-descriptor inspection may invoke `getPrototypeOf`, `ownKeys`, and `getOwnPropertyDescriptor` traps. For arrays, the implementation reads `length` from its own-property descriptor instead of performing an ordinary property get; a Proxy can still run a `getOwnPropertyDescriptor` trap. An array whose descriptor-reported length exceeds 1,000 is rejected before `Reflect.ownKeys` is called, so its `ownKeys` trap is not invoked by that path. For arrays within the length limit, an `ownKeys` trap can still execute and construct a key list before the returned-key count is checked. Numeric array index keys are included in the shared aggregate UTF-8 key budget; the structural `length` property is excluded.

The routine checks the returned key count before scanning the keys, but this only bounds work after `Reflect.ownKeys` returns. **This limitation also applies to ordinary, non-Proxy objects:** `Reflect.ownKeys` first materializes the complete array of own keys, and only then can the routine compare its length with the 1,000-entry limit. Consequently, the entry limit is a post-enumeration traversal bound, not a pre-allocation memory bound; a very large ordinary object may already incur substantial key-list allocation before rejection. For Proxies, an `ownKeys` trap may additionally execute arbitrary user code or construct the returned list itself. The function catches thrown errors and fails closed, but catching an exception does not undo side effects or prevent work already performed by reflection. There is no reliable in-process test that can distinguish every Proxy from an ordinary object without invoking reflective behavior that may itself trigger traps.

**Caller requirement:** accept only trusted plain data objects at this boundary. Do not pass attacker-controlled live objects or Proxies directly. Convert untrusted serialized input at a separately controlled parsing boundary, and use process/OS isolation and resource limits where hostile computation or hard memory isolation is required.

## Non-guarantees

- For arrays, the descriptor-reported length limit rejects lengths above 1,000 before own-key enumeration. For arrays within that limit and for ordinary objects, the entry limit still applies after `Reflect.ownKeys` has materialized its key list; it does not bound that allocation or work performed by a Proxy trap.
- The aggregate UTF-8 budget does not constrain memory already occupied by the caller's input.
- This mechanism does not replace OS memory limits, process isolation, or a sandbox.

## Required regression evidence

Tests verify exact per-string, per-key, aggregate value-byte, and aggregate key-byte boundaries; combined accounting of object keys and array index keys; rejection of an ordinary record with more than 1,000 own keys; rejection of an oversized array before its Proxy ownKeys trap; other rejection limits; getter avoidance for ordinary objects; descriptor-based array-length inspection; and the observable fact that Proxy traps execute during reflective inspection. The oversized-record test verifies rejection after enumeration; it does not demonstrate bounded pre-allocation memory. These tests document the boundary; they do not claim to neutralize Proxy traps.
