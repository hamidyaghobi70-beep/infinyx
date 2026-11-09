export default {
  async evaluate(request, options) {
    if (request.action === "hang") {
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

    if (request.action === "crash") process.exit(23);
    if (request.action === "invalid") return { effect: "allow" };
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
