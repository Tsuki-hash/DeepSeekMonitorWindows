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

  constructor(
    listen: (request: () => void) => Promise<Unlisten>,
    confirm: () => Promise<unknown>,
    navigate: (action: () => void) => void,
    onChange: (state: QuitRequestState) => void,
  ) {
    this.listen = listen;
    this.confirm = confirm;
    this.navigate = navigate;
    this.onChange = onChange;
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
    if (this.unlisten) this.release(this.unlisten);
    this.unlisten = null;
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

  private async register() {
    const registration = ++this.registration;
    this.publish({ listener: "registering" });
    try {
      const off = await this.listen(() => {
        if (
          this.active &&
          registration === this.registration &&
          this.state.listener !== "failed"
        ) {
          this.requestQuit();
        }
      });
      if (!this.active || registration !== this.registration) {
        this.release(off);
        return;
      }
      this.unlisten = off;
      this.publish({ listener: "ready" });
    } catch {
      if (!this.active || registration !== this.registration) return;
      this.publish({ listener: "failed", recovery: true });
    }
  }

  private async confirmQuit(intent: number) {
    if (
      this.state.command === "pending" ||
      this.state.command === "confirmed"
    ) {
      return;
    }
    this.publish({ command: "pending" });
    try {
      await this.confirm();
      if (!this.active || intent !== this.intent) return;
      // A successful IPC is terminal for this owner; repeated native events
      // while Windows is closing must not submit another command.
      this.publish({ command: "confirmed" });
    } catch {
      if (!this.active || intent !== this.intent) return;
      this.publish({ command: "failed" });
    }
  }
}
