/** 请求去重与凭据代际共享，避免清除后慢响应重新填回数据。 */
export class RequestGate<T> {
  private generation = 0;
  private pending: Promise<T> | null = null;

  invalidate() {
    this.generation += 1;
    this.pending = null;
  }

  run(fetch: (assertCurrent: () => void) => Promise<T>): Promise<T> {
    if (this.pending) return this.pending;
    const generation = this.generation;
    // Multi-step tasks must also check before starting each later side effect.
    // A checkpoint belongs to this generation, never to the latest run.
    const assertCurrent = () => {
      if (generation !== this.generation)
        throw new Error("请求已被新的凭据操作替代");
    };
    const request = Promise.resolve()
      .then(() => {
        assertCurrent();
        return fetch(assertCurrent);
      })
      .then((value) => {
        assertCurrent();
        return value;
      });
    this.pending = request;
    // 不能用无人接收的 finally 派生 Promise，否则失败时会产生 unhandled rejection。
    void request.then(
      () => this.release(request),
      () => this.release(request),
    );
    return request;
  }

  private release(request: Promise<T>) {
    if (this.pending === request) this.pending = null;
  }
}
