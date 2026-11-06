import type { UsageSyncStatus } from "./types";

let nextRequest = 0;
const pageInstance = Date.now().toString(36);
export const newUsageSyncRequest = () => `${pageInstance}-${++nextRequest}`;

/** Login progress has a separate owner from globally committed credentials. */
export class UsageSyncOwner {
  requestId: string | null = null;
  generation: number | null = null;
  ended = true;

  begin(requestId: string) {
    this.requestId = requestId;
    this.generation = null;
    this.ended = false;
  }

  owns(requestId: string) {
    return this.requestId === requestId;
  }

  accept(status: UsageSyncStatus) {
    if (
      !status.requestId ||
      status.requestId !== this.requestId ||
      (this.generation !== null && status.generation !== this.generation) ||
      (this.ended && status.active)
    ) return false;
    this.generation = status.generation;
    if (!status.active) this.ended = true;
    return true;
  }

  restore(status: UsageSyncStatus) {
    this.requestId = status.requestId;
    this.generation = status.generation;
    this.ended = !status.active;
  }

  finish(requestId: string) {
    if (!this.owns(requestId)) return false;
    this.ended = true;
    return true;
  }

  invalidate() {
    this.requestId = null;
    this.generation = null;
    this.ended = true;
  }
}
