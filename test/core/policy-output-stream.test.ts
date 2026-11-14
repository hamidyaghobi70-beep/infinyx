import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { observePolicyOutputStream } from "../../src/core/policy-output-stream.js";

describe("observePolicyOutputStream", () => {
  it.each(["stdout", "stderr"])("maps %s stream errors to a generic output failure", async () => {
    const stream = new PassThrough();
    const onChunk = vi.fn();
    const onFailure = vi.fn();
    observePolicyOutputStream(stream, onChunk, onFailure);

    const closed = new Promise<void>((resolve) => {
      stream.once("close", resolve);
    });
    stream.destroy(new Error("PRIVATE_TOKEN=must-not-escape"));
    await closed;

    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(onFailure).toHaveBeenCalledWith("OUTPUT_STREAM_FAILED");
    expect(onChunk).not.toHaveBeenCalled();
  });

  it("forwards chunks without retaining or transforming their contents", async () => {
    const stream = new PassThrough();
    const onChunk = vi.fn();
    const onFailure = vi.fn();
    observePolicyOutputStream(stream, onChunk, onFailure);

    stream.write(Buffer.from([0x41, 0x42]));
    stream.end();
    await new Promise<void>((resolve) => stream.once("close", resolve));

    expect(onChunk).toHaveBeenCalledTimes(1);
    expect(onChunk).toHaveBeenCalledWith(Buffer.from([0x41, 0x42]));
    expect(onFailure).not.toHaveBeenCalled();
  });
});
