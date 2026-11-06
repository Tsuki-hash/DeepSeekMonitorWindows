/** Events reduce latency; a mounted page also reconciles its active web login. */
export const USAGE_SYNC_RECONCILE_MS = 2_000;

type Unlisten = () => void;
type Clock = {
  setTimeout: (
    callback: () => void,
    delay: number,
  ) => ReturnType<typeof setTimeout>;
  clearTimeout: (timer: ReturnType<typeof setTimeout>) => void;
};
type Subscription = {
  install: (current: () => boolean) => Promise<Unlisten>;
  attempt: object | null;
  off: Unlisten | null;
};

/** Single-flight reads, bounded retry cadence, and revocable listener attempts. */
export class UsageSyncReconciler {
  private active = true;
  private started = false;
  private running = false;
  private wake = false;
  private initial = true;
  private readFailed = false;
  private timer: { id: ReturnType<typeof setTimeout> | null } | null = null;
  private readonly subscriptions: Subscription[];
  private readonly reconcile: (current: () => boolean) => Promise<void>;
  private readonly needed: () => boolean;
  private readonly listenerError: (failed: boolean) => void;
  private readonly readError: (error: unknown | null) => void;
  private readonly clock: Clock;

  constructor(options: {
    subscriptions: Subscription["install"][];
    reconcile: (current: () => boolean) => Promise<void>;
    needed: () => boolean;
    listenerError: (failed: boolean) => void;
    readError: (error: unknown | null) => void;
    clock: Clock;
  }) {
    this.subscriptions = options.subscriptions.map((install) => ({
      install,
      attempt: null,
      off: null,
    }));
    this.reconcile = options.reconcile;
    this.needed = options.needed;
    this.listenerError = options.listenerError;
    this.readError = options.readError;
    this.clock = options.clock;
  }

  start() {
    if (!this.active || this.started) return;
    this.started = true;
    void this.run();
  }

  request() {
    if (!this.active) return;
    this.wake = true;
    if (this.started && !this.running) this.schedule();
  }

  dispose() {
    this.active = false;
    const timer = this.timer;
    this.timer = null;
    if (timer?.id != null) this.clock.clearTimeout(timer.id);
    for (const slot of this.subscriptions) {
      slot.attempt = null;
      if (slot.off) this.release(slot.off);
      slot.off = null;
    }
  }

  private release(off: Unlisten) {
    try {
      void Promise.resolve(off()).catch(() => undefined);
    } catch {
      // The callback's owner was already revoked, even if disposal fails.
    }
  }

  private async install(slot: Subscription) {
    if (slot.off || !this.active) return;
    const attempt = {};
    slot.attempt = attempt;
    const current = () => this.active && slot.attempt === attempt;
    try {
      const off = await slot.install(current);
      if (!current()) this.release(off);
      else slot.off = off;
    } catch {
      if (slot.attempt === attempt) slot.attempt = null;
    }
  }

  private schedule() {
    if (!this.active || this.timer) return;
    const timer: { id: ReturnType<typeof setTimeout> | null } = { id: null };
    this.timer = timer;
    timer.id = this.clock.setTimeout(() => {
      if (!this.active || this.timer !== timer) return;
      this.timer = null;
      void this.run();
    }, USAGE_SYNC_RECONCILE_MS);
  }

  private async run() {
    if (!this.active || this.running) return;
    this.running = true;
    this.wake = false;
    try {
      // Subscribe first. Failed slots retry independently; successful ones are
      // not removed, and a rejected attempt's retained callbacks stay inert.
      await Promise.all(this.subscriptions.map((slot) => this.install(slot)));
      if (!this.active) return;
      this.listenerError(this.subscriptions.some((slot) => !slot.off));
      if (this.initial || this.readFailed || this.needed()) {
        try {
          await this.reconcile(() => this.active);
          if (!this.active) return;
          this.initial = false;
          this.readFailed = false;
          this.readError(null);
        } catch (error) {
          if (!this.active) return;
          this.readFailed = true;
          this.readError(error);
        }
      }
    } finally {
      this.running = false;
      if (
        this.active &&
        (this.wake ||
          this.initial ||
          this.readFailed ||
          this.needed() ||
          this.subscriptions.some((slot) => !slot.off))
      )
        this.schedule();
    }
  }
}
