export default {
  async evaluate(request, options) {
    if (request.action === "hang") {
      return new Promise(() => undefined);
    }

    if (request.action === "ignore-sigterm") {
      process.on("SIGTERM", () => undefined);
      setTimeout(() => process.exit(0), 2_000);
      return new Promise(() => undefined);
    }

    if (request.action === "cooperative") {
      return new Promise((resolve) => {
        if (options.signal.aborted) {
          resolve({ effect: "deny", reason: "Stopped cooperatively." });
          return;
        }
        options.signal.addEventListener("abort", () => {
          resolve({ effect: "deny", reason: "Stopped cooperatively." });
        }, { once: true });
      });
    }

    if (request.action === "stdout-boundary") {
      process.stdout.write(Buffer.alloc(512, 0x41));
      process.stdout.write(Buffer.alloc(512, 0x42));
      return { effect: "allow", reason: "Exact output boundary." };
    }
    if (request.action === "stderr-boundary") {
      process.stderr.write(Buffer.alloc(512, 0x41));
      process.stderr.write(Buffer.alloc(512, 0x42));
      return { effect: "allow", reason: "Exact stderr output boundary." };
    }
    if (request.action === "simultaneous-flood") {
      process.stdout.write(Buffer.alloc(1100, 0x41));
      process.stderr.write(Buffer.alloc(1100, 0x42));
      return { effect: "allow", reason: "Simultaneous output flood." };
    }
    if (request.action === "aggregate-flood") {
      process.stdout.write(Buffer.alloc(700, 0x41));
      process.stderr.write(Buffer.alloc(700, 0x42));
      return { effect: "allow", reason: "Aggregate flood attempted." };
    }
    if (request.action === "late-stdout-flood") {
      // The child runner's earlier message listener disconnects IPC on this
      // acknowledgement; this listener then emits output after parent freeze.
      process.once("message", (message) => {
        if (message?.type === "finalize") {
          process.stdout.write(Buffer.alloc(16 * 1024, 0x43));
        }
      });
      return { effect: "allow", reason: "Late flood attempted." };
    }
    if (request.action === "stdout-flood") {
      process.stdout.write(Buffer.alloc(16 * 1024, 0x41));
      return { effect: "allow", reason: "Flood attempted." };
    }
    if (request.action === "stderr-flood") {
      process.stderr.write(Buffer.alloc(16 * 1024, 0x42));
      return { effect: "allow", reason: "Flood attempted." };
    }
    if (request.action === "crash") process.exit(23);
    if (request.action === "invalid") return { effect: "allow" };
    if (request.action === "secret-reason") {
      return { effect: "allow", reason: "PRIVATE_TOKEN=fixture-secret-value" };
    }
    if (request.action === "secret-error") {
      throw new Error("PRIVATE_TOKEN=fixture-secret-value");
    }
    if (request.action === "secret-stderr") {
      process.stderr.write("PRIVATE_TOKEN=fixture-secret-value\\n");
      process.exit(24);
    }
    if (request.action === "deny") {
      return { effect: "deny", reason: "Explicit fixture denial." };
    }
    if (request.action === "heap-limit") {
      const v8 = await import("node:v8");
      return {
        effect: v8.getHeapStatistics().heap_size_limit < 256 * 1024 * 1024 ? "allow" : "deny",
        reason: "V8 heap limit inspected."
      };
    }

    if (request.action === "deadline") {
      return {
        effect: typeof options.deadlineAt === "number" ? "allow" : "deny",
        reason: "Deadline context inspected."
      };
    }
    return { effect: "allow", reason: "Explicit fixture grant." };
  }
};
