import { describe, expect, it, vi } from "vitest";
import type {
  ModuleContext,
  ProtectedOperationCaller,
  ProtectedOperationHandle,
  ProtectedOperationPort,
  ProtectedOperationResult,
  ProtectedOperationDefinition
} from "../../src/core/contracts.js";

// Compile-time assertions are checked by tsconfig.contract-tests.json in CI.
const mutableInput: { value: string } = { value: "caller-owned" };
const typedHandle: ProtectedOperationHandle<{ value: string }, string> = { id: "typed" };
function publicExecuteStillAcceptsMutableInput(port: ProtectedOperationPort): void {
  void port.execute(typedHandle, { actorId: "actor" }, mutableInput);
}
void publicExecuteStillAcceptsMutableInput;

const readonlyHandlerContract: ProtectedOperationDefinition<{ nested: { label: string } }, string> = {
  id: "readonly.type-check",
  action: "test.read",
  resource: "test:readonly",
  validateInput: (value: unknown): value is { nested: { label: string } } =>
    typeof value === "object" && value !== null && "nested" in value,
  handler: (input) => {
    // @ts-expect-error Handler input is deeply readonly.
    input.nested.label = "mutated";
    return input.nested.label;
  }
};
void readonlyHandlerContract;

// This intentionally models a pre-serialized-capability implementation.
const legacyPort: ProtectedOperationPort = {
  execute: async <TInput, TOutput>(
    _operation: ProtectedOperationHandle<TInput, TOutput>,
    _caller: ProtectedOperationCaller,
    _input: TInput
  ): Promise<ProtectedOperationResult<TOutput>> => ({
    status: "denied",
    reason: "compatibility fixture"
  })
};

describe("ProtectedOperationPort source compatibility", () => {
  it("accepts legacy implementations that only provide execute", async () => {
    await expect(legacyPort.execute({ id: "legacy" }, { actorId: "actor" }, "input"))
      .resolves.toEqual({ status: "denied", reason: "compatibility fixture" });
  });

  it("denies when serialized capability is absent instead of falling back to execute", async () => {
    const execute = vi.fn(async () => ({ status: "executed" as const, value: "unsafe fallback" }));
    const context = {
      moduleId: "legacy-module",
      events: {},
      protectedOperations: { execute }
    } as unknown as ModuleContext;
    const result = context.serializedProtectedOperations
      ? await context.serializedProtectedOperations.executeSerialized(
          { id: "legacy" }, "actor", "{}", "input"
        )
      : { status: "denied" as const, reason: "Serialized capability unavailable." };
    expect(result).toMatchObject({ status: "denied" });
    expect(execute).not.toHaveBeenCalled();
  });
});
