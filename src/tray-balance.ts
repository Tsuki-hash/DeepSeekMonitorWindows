export type TrayBalance = {
  total: string | null;
  currency: string | null;
  stale: boolean;
};
type Transport = (
  command: string,
  args?: Record<string, unknown>,
) => Promise<unknown>;
type RetryClock = {
  setTimeout: (
    callback: () => void,
    delay: number,
  ) => ReturnType<typeof setTimeout>;
  clearTimeout: (timer: ReturnType<typeof setTimeout>) => void;
};
const retryClock: RetryClock = {
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: (timer) => clearTimeout(timer),
};

/**
 * App cleanup must stop the old publisher before starting its replacement.
 * An already-sent update has an older allocated epoch; a late begin response
 * after stop never publishes. Native allocation alone does not change owner.
 */
export class TrayBalancePublisher {
  private transport: Transport;
  private clock: RetryClock;
  private active = true;
  private running = false;
  private session: number | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryGeneration = 0;
  private retryDelay = 0;
  private revision = 0;
  private publishedRevision = 0;
  private latest: TrayBalance | null = null;
  constructor(transport: Transport, clock: RetryClock = retryClock) {
    this.transport = transport;
    this.clock = clock;
  }
  start() {
    return this.ensureSessionAndPublish();
  }
  update(value: TrayBalance) {
    if (!this.active) return;
    this.latest = { ...value };
    this.revision++;
    void this.ensureSessionAndPublish();
  }
  stop() {
    this.active = false;
    this.latest = null;
    this.retryGeneration++;
    if (this.retryTimer !== null) {
      this.clock.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }
  private async ensureSessionAndPublish() {
    // 握手与发布共用单飞和唯一退避 timer。update 只替换待发布快照，
    // 不绕过失败退避，也不会在旧请求尚未完成时并发发布。
    if (!this.active || this.running || this.retryTimer !== null) return;
    this.running = true;
    try {
      if (this.session === null) {
        const session = await this.transport("begin_tray_balance_session");
        if (!this.active) return;
        if (
          typeof session !== "number" ||
          !Number.isSafeInteger(session) ||
          session <= 0
        ) {
          throw new Error("托盘会话不可用");
        }
        this.session = session;
        this.retryDelay = 0;
        // begin 只分配 epoch，不再修改原生 owner。尚无余额时也必须通过
        // 首次发布 null 初始化托盘，只有仍存活的实例才能提交这个 epoch。
        if (this.latest === null) {
          this.latest = { total: null, currency: null, stale: false };
          this.revision++;
        }
      }
      while (
        this.active &&
        this.latest !== null &&
        this.publishedRevision < this.revision
      ) {
        const revision = this.revision;
        const accepted = await this.transport("update_tray_balance", {
          session: this.session,
          revision,
          ...this.latest,
        });
        if (!this.active) return;
        if (accepted === false) {
          // 原生已由较新 epoch 接管。旧实例不能重新握手争夺 owner。
          this.stop();
          return;
        }
        if (accepted !== true) throw new Error("托盘发布确认不可用");
        // 成功只确认实际发送的代际。在途期间的新值（包括清 Key 的 null）
        // 继续由这个循环发送；失败后的 timer 同样只读取最新快照。
        this.publishedRevision = revision;
        this.retryDelay = 0;
      }
    } catch {
      // 没有 session 时重试握手；菜单/tooltip 的初始化同样走首次发布。
      // 已有 session 时重发最新 revision；不依赖下一次外部 update。
      this.scheduleRetry();
    } finally {
      this.running = false;
    }
  }
  private scheduleRetry() {
    if (!this.active || this.retryTimer !== null) return;
    // 持续失败按 1/2/4/8/16/30 秒退避，之后保持 30 秒，直到恢复或 stop。
    this.retryDelay =
      this.retryDelay === 0 ? 1000 : Math.min(this.retryDelay * 2, 30_000);
    const generation = ++this.retryGeneration;
    this.retryTimer = this.clock.setTimeout(() => {
      if (!this.active || generation !== this.retryGeneration) return;
      this.retryTimer = null;
      void this.ensureSessionAndPublish();
    }, this.retryDelay);
  }
}
