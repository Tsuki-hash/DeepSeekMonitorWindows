/** Synchronous ownership of the interval after draft approval and before exit. */
export class QuitInteractionGate {
  private owner: object | null = null;
  private revision = 0;
  private listeners = new Set<() => void>();

  allowed = () => this.owner === null;

  /** Async edits started before an exit attempt must not revive after failure. */
  capture = () => {
    const revision = this.revision;
    return () => this.allowed() && revision === this.revision;
  };

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  lock = () => {
    const owner = {};
    this.owner = owner;
    this.revision += 1;
    this.listeners.forEach((listener) => listener());
    return () => {
      if (this.owner !== owner) return;
      this.owner = null;
      this.listeners.forEach((listener) => listener());
    };
  };
}
