import type { AppConfig } from "./types";

export type UsageCleanupConfig = Pick<
  AppConfig,
  | "usageTokenRevision"
  | "usageTokenConfigured"
  | "configReadError"
  | "usageCleanupUnconfirmed"
>;

/** Monotonic operation identity, independent of any settings page or draft. */
export type UsageSessionCleanupOwner = { readonly generation: number };
export type UsageSessionCleanupSnapshot = {
  readonly owner: UsageSessionCleanupOwner;
  readonly phase: "pending" | "failed" | "succeeded" | "unconfirmed";
  readonly persistedOperationId: string | null;
  readonly previousPersistedOperationId: string | null;
  readonly tokenRevision: number | undefined;
  readonly tokenCleared: boolean;
  readonly superseded: boolean;
  readonly error: string | null;
};

/**
 * App-lifetime privacy state. Retains only operation/account revisions and the
 * result, never Token text or a page's callbacks/drafts. A timeout remains an
 * unconfirmed failure until an explicitly requested operation succeeds.
 */
export class UsageSessionCleanup {
  private generation = 0;
  private current: UsageSessionCleanupSnapshot | null = null;
  private readonly listeners = new Set<() => void>();

  get snapshot(): UsageSessionCleanupSnapshot | null {
    return this.current;
  }

  get pending(): boolean {
    return this.current?.phase === "pending";
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private publish(next: UsageSessionCleanupSnapshot | null): void {
    this.current = next;
    for (const listener of this.listeners) listener();
  }

  begin(config: UsageCleanupConfig | null): UsageSessionCleanupOwner | null {
    // Remounting must not permit another forget while this IPC is unresolved.
    if (this.pending) return null;
    const owner = { generation: ++this.generation };
    this.publish({
      owner,
      phase: "pending",
      persistedOperationId: null,
      previousPersistedOperationId: config?.usageCleanupUnconfirmed ?? null,
      tokenRevision: config?.configReadError
        ? undefined
        : config?.usageTokenRevision,
      tokenCleared: Boolean(
        config && !config.configReadError && !config.usageTokenConfigured,
      ),
      superseded: false,
      error: null,
    });
    return owner;
  }

  finish(owner: UsageSessionCleanupOwner, error: string | null): boolean {
    const operation = this.current;
    if (
      !operation ||
      operation.owner !== owner ||
      operation.phase !== "pending"
    )
      return false;
    this.publish({
      ...operation,
      phase: error === null ? "succeeded" : "failed",
      tokenCleared: operation.tokenCleared || error === null,
      error,
    });
    return true;
  }

  supersede(): void {
    if (this.current && !this.current.superseded)
      this.publish({ ...this.current, superseded: true });
  }

  observe(config: UsageCleanupConfig): void {
    if (config.configReadError) return;
    const marker = config.usageCleanupUnconfirmed ?? null;
    const operation = this.current;
    if (
      marker &&
      (!operation ||
        (operation.phase !== "pending" &&
          marker !== operation.persistedOperationId &&
          marker !== operation.previousPersistedOperationId))
    ) {
      // A restarted process has no owning IPC receipt. The durable record proves
      // that the THEN-current Token was removed, not that browser deletion ended
      // or that a later account is logged out. Never auto-retry this operation.
      this.publish({
        owner: { generation: ++this.generation },
        phase: "unconfirmed",
        persistedOperationId: marker,
        previousPersistedOperationId: null,
        tokenRevision: undefined,
        tokenCleared: true,
        superseded: true,
        error:
          "此前操作已清除当时的监控 Token，但应用重新打开后无法确认网页登录数据清理结果；这不代表当前账户已退出",
      });
      return;
    }
    if (!operation) return;
    const persistedOperationId =
      operation.phase === "pending" &&
      marker &&
      marker !== operation.previousPersistedOperationId
        ? marker
        : operation.persistedOperationId;
    // Use committed account revisions, not candidate text: B and ABA edits are
    // still just drafts, while a real replacement remains newer across remounts.
    const superseded =
      operation.superseded ||
      (config.usageTokenConfigured &&
        (operation.tokenCleared ||
          (operation.tokenRevision !== undefined &&
            operation.tokenRevision !== config.usageTokenRevision)));
    const tokenCleared = operation.tokenCleared || !config.usageTokenConfigured;
    if (
      superseded !== operation.superseded ||
      tokenCleared !== operation.tokenCleared ||
      persistedOperationId !== operation.persistedOperationId
    )
      this.publish({
        ...operation,
        superseded,
        tokenCleared,
        persistedOperationId,
      });
  }

  /** App teardown/reset only. Settings-page unmount must never call this. */
  reset(): void {
    this.publish(null);
  }

  get status(): string | null {
    const operation = this.current;
    if (!operation) return null;
    if (operation.superseded) {
      const result =
        operation.phase === "succeeded"
          ? "已完成；后续新登录或保存的账户不在该次清理范围内"
          : operation.phase === "pending"
            ? "仍在等待网页登录数据清理结果，不代表当前账户已退出"
            : `未确认完成：${operation.error}。若要清理当前账户，请在“账户隐私”中重新确认“退出并忘记账户”`;
      return `此前的“退出并忘记账户”${result}。`;
    }
    if (operation.phase === "succeeded")
      return "已清除监控 Token 和应用内网页登录数据，下次同步需要重新登录";
    const token = operation.tokenCleared
      ? "监控 Token 已清除"
      : "尚未确认监控 Token 已清除";
    if (operation.phase === "pending")
      return operation.tokenCleared
        ? `${token}；正在清理网页登录数据，尚未确认退出并忘记账户完成。`
        : "正在退出并忘记账户；尚未确认监控 Token 已清除或网页登录数据已清理。";
    return `${token}；网页登录数据清理尚未确认完成：${operation.error}。请在“账户隐私”中再次点击“退出并忘记账户”重试；若仍在清理，请等待完成。`;
  }
}

export const usageSessionCleanup = new UsageSessionCleanup();
