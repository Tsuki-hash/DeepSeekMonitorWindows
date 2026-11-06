/**
 * Native visibility ownership is synchronous, independent of React commits.
 * Hiding/losing a trusted state revokes every existing consumer, even if a
 * subsequent shown event is batched into the same React render.
 */
export class WindowVisibilityGate {
  private visible = false;
  private generation = 0;
  private invalidations = new Set<() => void>();

  isVisible = () => this.visible;
  epoch = () => this.generation;

  setVisible(visible: boolean) {
    this.visible = visible;
    if (visible) return;
    this.generation += 1;
    this.invalidations.forEach((invalidate) => invalidate());
  }

  subscribeInvalidation = (invalidate: () => void) => {
    this.invalidations.add(invalidate);
    return () => {
      this.invalidations.delete(invalidate);
    };
  };
}
