import { setTimeout as delay } from "node:timers/promises";

export type ProcessContainmentCapability =
  | "POSIX_PROCESS_GROUP_BEST_EFFORT"
  | "DIRECT_CHILD_ONLY";

export function getProcessContainmentCapability(): ProcessContainmentCapability {
  return process.platform === "win32" ? "DIRECT_CHILD_ONLY" : "POSIX_PROCESS_GROUP_BEST_EFFORT";
}

export function signalProcessGroup(
  processGroupId: number,
  signal: NodeJS.Signals
): boolean {
  if (process.platform === "win32" || !Number.isSafeInteger(processGroupId) || processGroupId <= 0) {
    return false;
  }
  try {
    process.kill(-processGroupId, signal);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return true;
    return false;
  }
}

export function isProcessGroupEmpty(processGroupId: number): boolean {
  if (process.platform === "win32" || !Number.isSafeInteger(processGroupId) || processGroupId <= 0) {
    return false;
  }
  try {
    process.kill(-processGroupId, 0);
    return false;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ESRCH";
  }
}

export async function waitForProcessGroupEmpty(
  processGroupId: number,
  timeoutMs: number,
  pollIntervalMs = 10
): Promise<boolean> {
  if (process.platform === "win32") return false;
  const deadline = Date.now() + timeoutMs;
  do {
    if (isProcessGroupEmpty(processGroupId)) return true;
    if (Date.now() >= deadline) return false;
    await delay(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())));
  } while (true);
}
