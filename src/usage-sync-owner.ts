import type { UsageSyncStatus } from "./types";

let nextRequest = 0;
const pageInstance = Date.now().toString(36);
export const newUsageSyncRequest = () => `${pageInstance}-${++nextRequest}`;

/** Login progress has a separate owner from globally committed credentials. */
export class UsageSyncOwner {
  requestId: string | null = null;
  generation: number | null = null;
  ended = true;

  begin(requestId: string) {
    this.requestId = requestId;
    this.generation = null;
    this.ended = false;
  }

  owns(requestId: string) {
    return this.requestId === requestId;
  }

  accept(status: UsageSyncStatus) {
    if (
      !status.requestId ||
      status.requestId !== this.requestId ||
      (this.generation !== null && status.generation !== this.generation) ||
      (this.ended && status.active)
    )
      return false;
    this.generation = status.generation;
    if (!status.active) this.ended = true;
    return true;
  }

  restore(status: UsageSyncStatus) {
    this.requestId = status.requestId;
    this.generation = status.generation;
    this.ended = !status.active;
  }

  finish(requestId: string) {
    if (!this.owns(requestId)) return false;
    this.ended = true;
    return true;
  }

  invalidate() {
    this.requestId = null;
    this.generation = null;
    this.ended = true;
  }
}

/**
 * IPC can enter Rust out of send order. Keep every unresolved credential-start
 * ID across settings unmounts so clear/forget can revoke even a not-yet-polled
 * command. Only request IDs are retained, never Token values.
 */
export class UsageSyncRequests {
  private readonly pending = new Set<string>();
  private clearBarrier: Promise<void> | null = null;

  async start<T>(
    requestId: string,
    action: (supersededRequestIds: string[]) => Promise<T>,
  ): Promise<T> {
    // A manual replacement or a newer web login also revokes older starts,
    // including ones whose async command has not reached Rust yet.
    const supersededRequestIds = [...this.pending];
    this.pending.add(requestId);
    try {
      // A new explicit login after Clear may reuse the retained web cache, but
      // only after Clear has finished. A late Clear must not cancel that login.
      const clearing = this.clearBarrier;
      if (clearing) await clearing;
      return await action(supersededRequestIds);
    } finally {
      this.pending.delete(requestId);
    }
  }

  clear<T>(action: (cancelledRequestIds: string[]) => Promise<T>): Promise<T> {
    // Snapshot at the user's action, not later when the queued clear runs.
    // Requests made after this point are new intent, not cancelled old work.
    const cancelledRequestIds = [...this.pending];
    const result = Promise.resolve(this.clearBarrier).then(() =>
      action(cancelledRequestIds),
    );
    const barrier = result.then(
      () => undefined,
      () => undefined,
    );
    this.clearBarrier = barrier;
    void barrier.then(() => {
      if (this.clearBarrier === barrier) this.clearBarrier = null;
    });
    // Preserve the real rejection for the caller's error UI. Releasing the
    // barrier on failure permits a subsequent explicit retry, not fake success.
    return result;
  }
}
