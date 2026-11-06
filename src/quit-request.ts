import type { QuitIntentMailbox } from "./quit-intent";

export type QuitRequestState = {
  listener: "registering" | "ready" | "failed";
  command: "idle" | "pending" | "failed" | "confirmed";
  /** Keep the registration recovery controls visible while retrying. */
  recovery: boolean;
};

export const initialQuitRequestState: QuitRequestState = {
  listener: "registering",
  command: "idle",
  recovery: false,
};

type Unlisten = () => void;
export const QUIT_RECONCILE_INTERVAL_MS = 2_000;
export type QuitRequestClock = {
  setTimeout: (
    callback: () => void,
    delay: number,
  ) => ReturnType<typeof setTimeout>;
  clearTimeout: (timer: ReturnType<typeof setTimeout>) => void;
};
const systemClock: QuitRequestClock = {
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: (timer) => clearTimeout(timer),
};

/** One mounted owner's tray subscription and guarded quit command. */
export class QuitRequest {
  private active = true;
  private started = false;
  private registration = 0;
  private intent = 0;
  private unlisten: Unlisten | null = null;
  private state: QuitRequestState = initialQuitRequestState;
  private readonly listen: (request: () => void) => Promise<Unlisten>;
  private readonly confirm: () => Promise<unknown>;
  private readonly navigate: (action: () => void) => void;
  private readonly onChange: (state: QuitRequestState) => void;
  private readonly lockInteractions: () => () => void;
  private releaseInteractions: (() => void) | null = null;
  private readonly mailbox?: QuitIntentMailbox;
  private readonly clock: QuitRequestClock;
  private reconciliation: {
    timer: ReturnType<typeof setTimeout> | null;
  } | null = null;

  constructor(
    listen: (request: () => void) => Promise<Unlisten>,
    confirm: () => Promise<unknown>,
    navigate: (action: () => void) => void,
    onChange: (state: QuitRequestState) => void,
    lockInteractions: () => () => void = () => () => {},
    mailbox?: QuitIntentMailbox,
    clock: QuitRequestClock = systemClock,
  ) {
    this.listen = listen;
    this.confirm = confirm;
    this.navigate = navigate;
    this.onChange = onChange;
    this.lockInteractions = lockInteractions;
    this.mailbox = mailbox;
    this.clock = clock;
  }

  start() {
    if (!this.active || this.started) return;
    this.started = true;
    void this.register();
  }

  retryListener = () => {
    // The synchronous state also rejects repeated clicks before React commits.
    if (!this.active || this.state.listener !== "failed") return;
    void this.register();
  };

  requestQuit = () => {
    if (
      !this.active ||
      !this.started ||
      this.state.command === "pending" ||
      this.state.command === "confirmed"
    ) {
      return;
    }
    const intent = ++this.intent;
    let consumed = false;
    // Every recovery action is a NEW intent through the shared draft guard.
    // Never retry a captured confirm_quit callback after a command failure.
    this.navigate(() => {
      if (!this.active || intent !== this.intent || consumed) return;
      consumed = true;
      void this.confirmQuit(intent);
    });
  };

  dispose() {
    this.active = false;
    this.registration += 1;
    this.intent += 1;
    this.cancelReconciliation();
    if (this.unlisten) this.release(this.unlisten);
    this.unlisten = null;
    this.releaseInteractions?.();
    this.releaseInteractions = null;
  }

  private publish(patch: Partial<QuitRequestState>) {
    if (!this.active) return;
    this.state = { ...this.state, ...patch };
    this.onChange(this.state);
  }

  private release(off: Unlisten) {
    // Revocation precedes disposal. Even if native cleanup fails, a retained
    // callback cannot navigate; sync throws and async rejection are consumed.
    try {
      void Promise.resolve(off()).catch(() => undefined);
    } catch {
      // No live owner remains to receive a cleanup failure.
    }
  }

  private cancelReconciliation() {
    const scheduled = this.reconciliation;
    // Revoke identity first: a host may still deliver a cancelled callback.
    this.reconciliation = null;
    if (scheduled?.timer != null) this.clock.clearTimeout(scheduled.timer);
  }

  private async register() {
    const registration = ++this.registration;
    this.cancelReconciliation();
    this.publish({ listener: "registering" });
    const current = () =>
      this.active &&
      registration === this.registration &&
      this.state.listener !== "failed" &&
      // Confirmed exit is terminal even for a read/ack already in flight.
      // Late results cannot consume another intent or publish recovery UI.
      this.state.command !== "confirmed";
    const fail = () => {
      if (!current()) return;
      this.cancelReconciliation();
      this.publish({ listener: "failed", recovery: true });
      if (this.unlisten) this.release(this.unlisten);
      this.unlisten = null;
    };
    let installed = false;
    let wake = false;
    let reading = false;
    let read: Promise<void> = Promise.resolve();
    const drain = () => {
      wake = true;
      if (reading) return read;
      reading = true;
      read = (async () => {
        try {
          while (wake && current()) {
            wake = false;
            await this.mailbox?.consume(current, this.requestQuit);
          }
        } finally {
          reading = false;
        }
      })();
      return read;
    };
    const scheduleReconciliation = () => {
      if (
        !this.mailbox ||
        !current() ||
        this.state.listener !== "ready" ||
        this.state.command === "confirmed" ||
        this.reconciliation !== null
      )
        return;
      const scheduled: { timer: ReturnType<typeof setTimeout> | null } = {
        timer: null,
      };
      this.reconciliation = scheduled;
      scheduled.timer = this.clock.setTimeout(() => {
        if (this.reconciliation !== scheduled || !current()) return;
        this.reconciliation = null;
        // Native events are only a latency optimization. Reconcile even when
        // an emit failed or its wake was lost after the initial handshake.
        // Reuse the single-flight drain, and rearm only after read + ack settle.
        void drain().then(scheduleReconciliation).catch(fail);
      }, QUIT_RECONCILE_INTERVAL_MS);
    };
    try {
      const off = await this.listen(() => {
        if (!current()) return;
        if (this.mailbox) {
          // Events are only wakes. Never trust/replay an old event as approval.
          // Wakes racing an in-flight snapshot force one more native read.
          wake = true;
          if (installed) void drain().catch(fail);
        } else {
          this.requestQuit();
        }
      });
      if (!this.active || registration !== this.registration) {
        this.release(off);
        return;
      }
      this.unlisten = off;
      installed = true;
      // Subscribe first, then replay: neither side of registration has a gap.
      if (this.mailbox) await drain();
      if (!current()) return;
      this.publish({ listener: "ready" });
      scheduleReconciliation();
    } catch {
      fail();
    }
  }

  private async confirmQuit(intent: number) {
    if (
      this.state.command === "pending" ||
      this.state.command === "confirmed"
    ) {
      return;
    }
    // Lock synchronously, before React commits or IPC can deliver a reply.
    this.releaseInteractions = this.lockInteractions();
    this.publish({ command: "pending" });
    try {
      await this.confirm();
      if (!this.active || intent !== this.intent) return;
      // A successful IPC is terminal for this owner; repeated native events
      // while Windows is closing must not submit another command.
      this.publish({ command: "confirmed" });
      this.cancelReconciliation();
    } catch {
      if (!this.active || intent !== this.intent) return;
      this.releaseInteractions?.();
      this.releaseInteractions = null;
      this.publish({ command: "failed" });
    }
  }
}
