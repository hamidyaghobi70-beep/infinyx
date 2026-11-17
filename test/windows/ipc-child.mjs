process.on("message", (message) => {
  if (!message || typeof message !== "object") return;
  if (message.type === "evaluate") {
    process.stdout.write("POC_STDOUT\n");
    process.stderr.write("POC_STDERR\n");
    process.send?.({ type: "started", requestId: message.requestId });
  } else if (message.type === "cancel") {
    process.send?.({ type: "cancelled", reason: message.reason });
  } else if (message.type === "finalize") {
    process.send?.({ type: "finalized" }, () => process.disconnect());
  }
});
