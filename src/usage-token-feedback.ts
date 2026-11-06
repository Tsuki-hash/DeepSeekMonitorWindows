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

export type UsageSessionCleanupOwner = { readonly generation: number };

/** Page-local feedback. Privacy cleanup never borrows a candidate draft owner. */
export class UsageTokenFeedback {
  private config: TokenConfig | null;
  private generation = 0;
  private configGeneration = 0;
  private message: string | null = null;
  private source: "draft" | "sync" = "draft";
  private cleanupGeneration = 0;
  private cleanup: {
    owner: UsageSessionCleanupOwner;
    phase: "pending" | "failed" | "succeeded";
    superseded: boolean;
    tokenRevision: number | undefined;
    tokenCleared: boolean;
    error: string | null;
  } | null = null;

  constructor(config: TokenConfig | null) {
    this.config = config;
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
    const cleanup = this.cleanupStatus;
    if (cleanup)
      return this.message !== null || this.cleanup?.superseded
        ? `${draft}。${cleanup}`
        : cleanup;
    return draft;
  }

  private get cleanupStatus(): string | null {
    const cleanup = this.cleanup;
    if (!cleanup) return null;
    if (cleanup.superseded) {
      const result =
        cleanup.phase === "succeeded"
          ? "已完成；后续新登录或保存的账户不在该次清理范围内"
          : cleanup.phase === "pending"
            ? "仍在等待网页登录数据清理结果，不代表当前账户已退出"
            : `未确认完成：${cleanup.error}。若要清理当前账户，请在“账户隐私”中重新确认“退出并忘记账户”`;
      return `此前的“退出并忘记账户”${result}。`;
    }
    if (cleanup.phase === "succeeded")
      return "已清除监控 Token 和应用内网页登录数据，下次同步需要重新登录";
    const token = cleanup.tokenCleared
      ? "监控 Token 已清除"
      : "尚未确认监控 Token 已清除";
    if (cleanup.phase === "pending")
      return cleanup.tokenCleared
        ? `${token}；正在清理网页登录数据，尚未确认退出并忘记账户完成。`
        : "正在退出并忘记账户；尚未确认监控 Token 已清除或网页登录数据已清理。";
    return `${token}；网页登录数据清理尚未确认完成：${cleanup.error}。请在“账户隐私”中再次点击“退出并忘记账户”重试；若仍在清理，请等待完成。`;
  }

  beginCleanup(): UsageSessionCleanupOwner {
    const owner = { generation: ++this.cleanupGeneration };
    this.cleanup = {
      owner,
      phase: "pending",
      superseded: false,
      tokenRevision: this.config?.configReadError
        ? undefined
        : this.config?.usageTokenRevision,
      tokenCleared: Boolean(
        this.config &&
        !this.config.configReadError &&
        !this.config.usageTokenConfigured,
      ),
      error: null,
    };
    return owner;
  }

  finishCleanup(
    owner: UsageSessionCleanupOwner,
    error: string | null,
  ): boolean {
    const cleanup = this.cleanup;
    if (!cleanup || cleanup.owner !== owner || cleanup.phase !== "pending")
      return false;
    cleanup.phase = error === null ? "succeeded" : "failed";
    cleanup.error = error;
    return true;
  }

  invalidateCleanup(): void {
    this.cleanup = null;
  }

  supersedeCleanup(): void {
    // Keep the old operation's result as history, not as the new account's
    // validation/status. Only an explicit new forget replaces this owner.
    if (this.cleanup) this.cleanup.superseded = true;
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
    // A newly committed account supersedes the old account's cleanup status.
    // Ordinary edits, duplicate clear events and preference commits do not.
    if (
      !next.configReadError &&
      next.usageTokenConfigured &&
      (tokenChanged ||
        (this.cleanup?.tokenRevision !== undefined &&
          this.cleanup.tokenRevision !== next.usageTokenRevision))
    )
      this.supersedeCleanup();
    if (this.cleanup && !next.configReadError && !next.usageTokenConfigured)
      this.cleanup.tokenCleared = true;
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
