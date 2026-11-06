/** Renderer-lifetime deduplication shared by StrictEffects/remounted owners.
 * Native retains unacknowledged intent across listener setup; this watermark
 * also prevents an ack failure from re-opening an already cancelled prompt.
 */
export class QuitIntentMailbox {
  private consumed = 0n;
  private readonly read: () => Promise<string | null>;
  private readonly acknowledge: (intent: string) => Promise<unknown>;

  constructor(
    read: () => Promise<string | null>,
    acknowledge: (intent: string) => Promise<unknown>,
  ) {
    this.read = read;
    this.acknowledge = acknowledge;
  }

  async consume(isCurrent: () => boolean, request: () => void) {
    const intent = await this.read();
    // A late snapshot must remain pending for the replacement owner.
    if (!isCurrent() || intent === null) return;
    if (typeof intent !== "string" || !/^[1-9][0-9]{0,19}$/.test(intent)) {
      throw new Error("Invalid quit intent");
    }
    const sequence = BigInt(intent);
    if (sequence > 18_446_744_073_709_551_615n) {
      throw new Error("Invalid quit intent");
    }
    if (sequence > this.consumed) {
      // Mark before entering the guard: Stay/Cancel consumes this exact intent,
      // and another owner/event must not silently revive it while ack is slow.
      this.consumed = sequence;
      request();
    }
    await this.acknowledge(intent);
  }
}
