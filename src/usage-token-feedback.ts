import type { AppConfig } from "./types";
import { UsageSessionCleanup } from "./usage-session-cleanup.ts";
import type { UsageSessionCleanupOwner } from "./usage-session-cleanup.ts";

type TokenConfig = Pick<
  AppConfig,
  "usageTokenRevision" | "usageTokenConfigured" | "configReadError"
>;

export type UsageTokenFeedbackOwner = {
  generation: number;
  draftRevision: number;
  configGeneration: number;
};

/** Page-local candidate feedback, composed with separate app-lifetime privacy state. */
export class UsageTokenFeedback {
  private config: TokenConfig | null;
  private generation = 0;
  private configGeneration = 0;
  private message: string | null = null;
  private source: "draft" | "sync" = "draft";
  private readonly cleanup: UsageSessionCleanup;

  constructor(config: TokenConfig | null, cleanup = new UsageSessionCleanup()) {
    this.config = config;
    this.cleanup = cleanup;
  }

  get status(): string {
    if (this.config?.configReadError) return this.config.configReadError;
    const draft =
      this.message ??
      (!this.config
        ? "正在读取本地配置"
        : this.config.usageTokenConfigured
          ? "用量 Token 已配置"
          : "未配置用量 Token");
    const cleanup = this.cleanup.status;
    if (cleanup)
      return this.message !== null || this.cleanup.snapshot?.superseded
        ? `${draft}。${cleanup}`
        : cleanup;
    return draft;
  }

  beginCleanup(): UsageSessionCleanupOwner | null {
    return this.cleanup.begin(this.config);
  }

  finishCleanup(
    owner: UsageSessionCleanupOwner,
    error: string | null,
  ): boolean {
    return this.cleanup.finish(owner, error);
  }

  supersedeCleanup(): void {
    this.cleanup.supersede();
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
    this.cleanup.observe(next);
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
    message: string | null,
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
