process.stderr.write(`POC_CHILD_BOOT connected=${process.connected} channelFd=${process.env.NODE_CHANNEL_FD ?? "unset"}\n`);

if (process.connected && process.send) {
  process.send({ type: "ready", channelFd: process.env.NODE_CHANNEL_FD ?? null });
}

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
