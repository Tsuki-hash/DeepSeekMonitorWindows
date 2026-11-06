export type TrayBalance = {
  total: string | null;
  currency: string | null;
  stale: boolean;
};
type Transport = (
  command: string,
  args?: Record<string, unknown>,
) => Promise<unknown>;

/** A renderer must acquire its own native epoch; local sequences never span reloads. */
export class TrayBalancePublisher {
  private transport: Transport;
  private active = true;
  private starting = false;
  private session: number | null = null;
  /** 复评 N13：发布失败后的有界退避状态与唯一待重试 timer。 */
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryDelay = 0;
  private revision = 0;
  private latest: TrayBalance | null = null;
  constructor(transport: Transport) {
    this.transport = transport;
  }
  async start() {
    if (!this.active || this.starting || this.session !== null) return;
    this.starting = true;
    try {
      const session = await this.transport("begin_tray_balance_session");
      if (
        !this.active ||
        typeof session !== "number" ||
        !Number.isSafeInteger(session) ||
        session <= 0
      )
        return;
      this.session = session;
      this.publish();
    } catch {
      // A later balance change retries initialization; no browser storage is needed.
    } finally {
      this.starting = false;
    }
  }
  update(value: TrayBalance) {
    if (!this.active) return;
    this.latest = value;
    this.revision++;
    if (this.session === null) void this.start();
    else this.publish();
  }
  stop() {
    this.active = false;
    // 复评 N13：销毁时取消待重试，不留 timer。
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }
  private publish() {
    if (!this.active || this.session === null || !this.latest) return;
    // 复评 N13：发布失败必须**重试**。旧实现 `.catch(() => undefined)` 直接吞掉
    // 失败：原生 set_text/tooltip 一次失败后，若凭据已清除又没有新变化，
    // 托盘会长期停留在旧金额且没有任何补救。
    // 这里用单飞 + 有界退避 + 最新代际：成功才结束，失败按 1/2/4/8/16 秒
    //（上限 30 秒）重试；期间有更新的发布则用最新值重试，旧值不覆盖新值。
    const revision = this.revision;
    void this.transport("update_tray_balance", {
      session: this.session,
      revision,
      ...this.latest,
    })
      .then(() => {
        if (revision === this.revision) this.retryDelay = 0;
      })
      .catch(() => this.scheduleRetry());
  }
  private scheduleRetry() {
    if (!this.active || this.retryTimer !== null) return;
    // 有界退避：1s 起，逐次翻倍，上限 30s。持续失败只保留一个 timer。
    this.retryDelay =
      this.retryDelay === 0 ? 1000 : Math.min(this.retryDelay * 2, 30_000);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.publish();
    }, this.retryDelay);
  }
}
