import type { AppConfig } from "./types";

type TokenConfig = Pick<
  AppConfig,
  "usageTokenRevision" | "usageTokenConfigured" | "configReadError"
>;

export type UsageTokenFeedbackOwner = {
  generation: number;
  draftRevision: number;
  configGeneration: number;
};

/** Page-local draft/feedback ownership, separate from persisted Token and login. */
export class UsageTokenFeedback {
  private config: TokenConfig | null;
  private generation = 0;
  private configGeneration = 0;
  private message: string | null = null;
  private source: "draft" | "sync" = "draft";

  constructor(config: TokenConfig | null) {
    this.config = config;
  }

  get status(): string {
    if (this.config?.configReadError) return this.config.configReadError;
    if (this.message !== null) return this.message;
    if (!this.config) return "正在读取本地配置";
    return this.config.usageTokenConfigured
      ? "用量 Token 已配置"
      : "未配置用量 Token";
  }

  observe(next: TokenConfig, syncing = false): void {
    const previous = this.config;
    const trustChanged =
      Boolean(previous?.configReadError) !== Boolean(next.configReadError);
    const tokenChanged =
      previous &&
      !previous.configReadError &&
      !next.configReadError &&
      (previous.usageTokenRevision !== next.usageTokenRevision ||
        previous.usageTokenConfigured !== next.usageTokenConfigured);
    if (trustChanged || tokenChanged) {
      this.configGeneration += 1;
      // An unrelated/older session's accepted Token commit cannot hide the
      // current web login's progress. Its request owner still decides when it ends.
      if (trustChanged || !syncing || this.source !== "sync")
        this.message = null;
    }
    // First trusted reads and Key/preference commits are not Token changes.
    this.config = next;
  }

  capture(draftRevision: number): UsageTokenFeedbackOwner {
    return {
      generation: this.generation,
      draftRevision,
      configGeneration: this.configGeneration,
    };
  }

  edit(): void {
    this.generation += 1;
    this.message = null;
  }

  begin(
    draftRevision: number,
    message: string,
    source: "draft" | "sync" = "draft",
  ): UsageTokenFeedbackOwner {
    this.edit();
    this.message = message;
    this.source = source;
    return this.capture(draftRevision);
  }

  ownsIntent(owner: UsageTokenFeedbackOwner, draftRevision: number): boolean {
    return (
      owner.generation === this.generation &&
      owner.draftRevision === draftRevision
    );
  }

  update(
    owner: UsageTokenFeedbackOwner,
    draftRevision: number,
    message: string | null,
    accepted = false,
    source: "draft" | "sync" = "draft",
  ): boolean {
    if (
      !this.ownsIntent(owner, draftRevision) ||
      this.config?.configReadError ||
      (!accepted && owner.configGeneration !== this.configGeneration)
    )
      return false;
    // Only a current accepted receipt or request-owned sync update may cross a
    // Token commit boundary. Clipboard results/failures cannot claim that right.
    this.message = message;
    this.source = source;
    return true;
  }
}
