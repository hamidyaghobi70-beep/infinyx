import { AsyncLocalStorage } from "node:async_hooks";
import { CoreError } from "./core-error.js";

export type OperationHandleState =
  | "IDLE"
  | "TRACKING"
  | "RELEASED_MANUAL"
  | "SETTLED";

export class OperationHandle {
  state: OperationHandleState = "IDLE";
  pendingPromiseCount = 0;
  private manualReleaseRequested = false;

  constructor(private readonly registry: OperationRegistry) {}

  track<T>(promise: PromiseLike<T>): Promise<T> {
    if (this.manualReleaseRequested || this.state === "RELEASED_MANUAL" || this.state === "SETTLED") {
      throw new CoreError(
        "OPERATION_HANDLE_ALREADY_RELEASED",
        "The operation handle can no longer track promises."
      );
    }

    this.registry.beginTrack(this);
    return Promise.resolve(promise).then(
      (value) => {
        this.registry.settle(this);
        return value;
      },
      (error: unknown) => {
        this.registry.settle(this);
        throw error;
      }
    );
  }

  release(): void {
    if (this.state === "RELEASED_MANUAL" || this.state === "SETTLED") return;
    this.manualReleaseRequested = true;
    this.registry.release(this);
  }

  markTracking(): void {
    this.state = "TRACKING";
  }

  markReleased(): void {
    this.state = this.pendingPromiseCount === 0 ? "RELEASED_MANUAL" : "TRACKING";
  }

  markSettled(): void {
    this.state = this.manualReleaseRequested ? "RELEASED_MANUAL" : "SETTLED";
  }
}

/**
 * Linearizable admission and settlement registry.
 *
 * Every mutation below is synchronous and contains no await point. In a Node.js
 * event loop this is the critical section: a child either registers while its
 * parent is still present, or observes that the parent has already settled.
 */
export class OperationRegistry {
  private readonly context = new AsyncLocalStorage<OperationHandle>();
  private readonly handles = new Map<OperationHandle, number>();
  private readonly drainWaiters = new Set<() => void>();
  private closed = false;
  private pendingPromiseCount = 0;

  get activeHandleCount(): number {
    return this.handles.size;
  }

  get activePromiseCount(): number {
    return this.pendingPromiseCount;
  }

  closeAdmission(): void {
    this.closed = true;
  }

  assertSynchronousAdmission(): void {
    const parent = this.context.getStore();
    if (parent) {
      if (!this.handles.has(parent)) {
        throw new CoreError(
          "OPERATION_PARENT_SETTLED",
          "The parent operation has already settled; detached work is not admitted."
        );
      }
      return;
    }
    if (this.closed) {
      throw new CoreError(
        "OPERATION_ADMISSION_CLOSED",
        "Core Engine operation admission is closed."
      );
    }
  }

  run<T>(operation: () => T | PromiseLike<T>): Promise<Awaited<T>> {
    return this.runWithAdmission(operation, false);
  }

  runCleanup<T>(operation: () => T | PromiseLike<T>): Promise<Awaited<T>> {
    // Cleanup is an internal root operation. Its nested service calls remain
    // tracked as children even though ordinary admission has been closed.
    return this.runWithAdmission(operation, true);
  }

  private runWithAdmission<T>(
    operation: () => T | PromiseLike<T>,
    allowClosedRoot: boolean
  ): Promise<Awaited<T>> {
    const parent = this.context.getStore();
    let handle: OperationHandle;
    try {
      handle = this.tryEnter(parent, allowClosedRoot);
    } catch (error) {
      return Promise.reject(error);
    }
    const promise = this.context.run(handle, () => {
      try {
        return Promise.resolve(operation());
      } catch (error) {
        return Promise.reject(error);
      }
    });
    return handle.track(promise);
  }

  tryEnter(parent?: OperationHandle, allowClosedRoot = false): OperationHandle {
    if (parent) {
      if (!this.handles.has(parent)) {
        throw new CoreError(
          "OPERATION_PARENT_SETTLED",
          "The parent operation has already settled; detached work is not admitted."
        );
      }
    } else if (this.closed && !allowClosedRoot) {
      throw new CoreError(
        "OPERATION_ADMISSION_CLOSED",
        "Core Engine operation admission is closed."
      );
    }

    const handle = new OperationHandle(this);
    this.handles.set(handle, 0);
    return handle;
  }

  beginTrack(handle: OperationHandle): void {
    if (!this.handles.has(handle)) {
      throw new CoreError(
        "OPERATION_HANDLE_ALREADY_RELEASED",
        "The operation handle is no longer registered."
      );
    }
    handle.pendingPromiseCount += 1;
    this.pendingPromiseCount += 1;
    handle.markTracking();
    this.handles.set(handle, handle.pendingPromiseCount);
  }

  settle(handle: OperationHandle): void {
    const pending = this.handles.get(handle);
    if (pending === undefined || pending <= 0) {
      throw new CoreError(
        "OPERATION_COUNTER_UNDERFLOW",
        "Operation settlement would underflow the registry counters."
      );
    }

    handle.pendingPromiseCount -= 1;
    this.pendingPromiseCount -= 1;
    if (handle.pendingPromiseCount === 0) {
      this.handles.delete(handle);
      handle.markSettled();
    } else {
      this.handles.set(handle, handle.pendingPromiseCount);
    }
    this.resolveDrainIfEmpty();
  }

  release(handle: OperationHandle): void {
    const pending = this.handles.get(handle);
    if (pending === undefined) return;
    if (pending === 0) {
      this.handles.delete(handle);
      handle.markReleased();
      this.resolveDrainIfEmpty();
    } else {
      handle.markReleased();
    }
  }

  drain(timeoutMs: number): Promise<void> {
    const current = this.context.getStore();
    if (current && this.handles.has(current)) {
      return Promise.reject(new CoreError(
        "OPERATION_DRAIN_SELF_WAIT",
        "An active operation cannot wait for a drain that includes itself."
      ));
    }
    if (this.handles.size === 0) return Promise.resolve();

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        this.drainWaiters.delete(onEmpty);
        if (error) reject(error);
        else resolve();
      };
      const onEmpty = (): void => finish();
      this.drainWaiters.add(onEmpty);
      const timeout = setTimeout(() => {
        finish(new CoreError(
          "OPERATION_DRAIN_TIMEOUT",
          "Timed out waiting for all admitted Core Engine operations to settle."
        ));
      }, timeoutMs);
      if (this.handles.size === 0) finish();
    });
  }

  private resolveDrainIfEmpty(): void {
    if (this.handles.size !== 0) return;
    for (const resolve of [...this.drainWaiters]) resolve();
  }
}
