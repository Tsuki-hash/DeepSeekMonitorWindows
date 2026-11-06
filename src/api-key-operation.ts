/** 设置页卸载再挂载也共享操作代际，旧保存不能恢复首页余额。 */
let generation = 0;
export const beginApiKeyOperation = () => ++generation;
export const isCurrentApiKeyOperation = (operation: number) =>
  operation === generation;

let nextRequest = 0;
const pageInstance = Date.now().toString(36);
export const newApiKeyRequest = () => `${pageInstance}-key-${++nextRequest}`;

/**
 * API Key IPC has its own app-lifetime owner, independent of Token login.
 * Register before sending, including while waiting for Clear. A later save or
 * clear must be able to revoke an older command that has not entered Rust yet.
 * Only opaque request IDs are retained here, never credential values.
 */
export class ApiKeyRequests {
  private readonly pending = new Set<string>();
  private clearBarrier: Promise<void> | null = null;

  async save<T>(
    requestId: string,
    action: (supersededRequestIds: string[]) => Promise<T>,
  ): Promise<T> {
    const supersededRequestIds = [...this.pending];
    this.pending.add(requestId);
    try {
      const clearing = this.clearBarrier;
      if (clearing) await clearing;
      return await action(supersededRequestIds);
    } finally {
      this.pending.delete(requestId);
    }
  }

  clear<T>(action: (cancelledRequestIds: string[]) => Promise<T>): Promise<T> {
    // Capture user intent now, not when an earlier clear finishes. A save
    // explicitly requested after this clear belongs to the next operation.
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
    // Only the sequencing barrier absorbs errors. The actual caller still
    // receives the failure, retains its draft, and can make an explicit retry.
    return result;
  }
}

// Token commands share a generation across settings remounts too. Backend commit
// versions, not these UI intent counters, decide which persisted snapshot wins.
let tokenGeneration = 0;
export const beginUsageTokenOperation = () => ++tokenGeneration;
export const isCurrentUsageTokenOperation = (operation: number) =>
  operation === tokenGeneration;
