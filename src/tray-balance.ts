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
  }
  private publish() {
    if (!this.active || this.session === null || !this.latest) return;
    void this.transport("update_tray_balance", {
      session: this.session,
      revision: this.revision,
      ...this.latest,
    }).catch(() => undefined);
  }
}
