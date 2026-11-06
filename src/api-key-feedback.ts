import type { AppConfig } from "./types";

type KeyConfig = Pick<
  AppConfig,
  "apiKeyRevision" | "apiKeyConfigured" | "apiKeyPreview" | "configReadError"
>;

export type ApiKeyFeedbackOwner = {
  generation: number;
  draftRevision: number;
  configGeneration: number;
};

/** Page-local feedback only. Never owns credentials, writes, or draft commits. */
export class ApiKeyFeedback {
  private config: KeyConfig | null;
  private generation = 0;
  private configGeneration = 0;
  private message: string | null = null;
  private readMessage: string | null = null;

  constructor(config: KeyConfig | null) {
    this.config = config;
  }

  get status(): string {
    if (this.config?.configReadError) return this.config.configReadError;
    if (this.message !== null) return this.message;
    if (this.readMessage !== null) return this.readMessage;
    if (!this.config) return "正在读取本地配置";
    return this.config.apiKeyConfigured
      ? this.config.apiKeyPreview
        ? `已配置 ${this.config.apiKeyPreview}`
        : "API Key 已配置"
      : "未配置 API Key";
  }

  observe(next: KeyConfig | null): void {
    // A successful accepted read/event repairs a previous transport/read error,
    // even when the first trusted snapshot must preserve candidate feedback.
    this.readMessage = null;
    const previous = this.config;
    const trustChanged =
      Boolean(previous?.configReadError) !== Boolean(next?.configReadError);
    const keyChanged =
      previous &&
      next &&
      !previous.configReadError &&
      !next.configReadError &&
      (previous.apiKeyRevision !== next.apiKeyRevision ||
        previous.apiKeyConfigured !== next.apiKeyConfigured ||
        previous.apiKeyPreview !== next.apiKeyPreview);
    if (trustChanged || keyChanged || (previous && !next)) {
      this.configGeneration += 1;
      this.message = null;
    }
    // The first trusted GET establishes a baseline, not a credential change.
    // Position/Token/other preference revisions keep candidate feedback.
    this.config = next;
  }

  capture(draftRevision: number): ApiKeyFeedbackOwner {
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

  begin(draftRevision: number, message: string): ApiKeyFeedbackOwner {
    this.edit();
    this.message = message;
    return this.capture(draftRevision);
  }

  ownsIntent(owner: ApiKeyFeedbackOwner, draftRevision: number): boolean {
    return (
      owner.generation === this.generation &&
      owner.draftRevision === draftRevision
    );
  }

  owns(owner: ApiKeyFeedbackOwner, draftRevision: number): boolean {
    return (
      this.ownsIntent(owner, draftRevision) &&
      !this.config?.configReadError &&
      owner.configGeneration === this.configGeneration
    );
  }

  readFailed(
    owner: ApiKeyFeedbackOwner,
    draftRevision: number,
    message: string,
  ): void {
    if (this.owns(owner, draftRevision)) this.readMessage = message;
  }

  update(
    owner: ApiKeyFeedbackOwner,
    draftRevision: number,
    message: string,
    committed = false,
  ): boolean {
    if (
      !this.ownsIntent(owner, draftRevision) ||
      this.config?.configReadError ||
      (!committed && owner.configGeneration !== this.configGeneration)
    )
      return false;
    // A successful command may have broadcast its own new Key revision before
    // its response. Only the caller's current, accepted credential receipt may
    // cross that boundary; failures/clipboard/read results never may.
    this.message = message;
    return true;
  }
}
