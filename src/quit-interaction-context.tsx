import React from "react";
import { QuitInteractionGate } from "./quit-interaction";

const standaloneGate = new QuitInteractionGate();
export const QuitInteractionContext = React.createContext(standaloneGate);
export const useQuitInteractionGate = () =>
  React.useContext(QuitInteractionContext);

/** The native event fence and inert update happen before confirm_quit is sent. */
export function useQuitInteractionBoundary(
  gate: QuitInteractionGate,
  stage: React.RefObject<HTMLDivElement>,
) {
  const restore = React.useRef(new Map<HTMLElement, boolean>());
  const apply = React.useCallback(() => {
    const root = stage.current;
    if (typeof HTMLElement === "undefined" || !(root instanceof HTMLElement))
      return;
    const blocked = !gate.allowed();
    // Do not mark the status ancestor aria-busy: that would defer its live
    // announcement until after a successful exit, when it is no longer useful.
    root.setAttribute("data-quit-locked", String(blocked));
    for (const child of Array.from(root.children ?? [])) {
      if (!(child instanceof HTMLElement)) continue;
      // Keep the closing status accessible. Its buttons have their own guards.
      if (child.classList.contains("visibility-error")) continue;
      if (blocked) {
        if (!restore.current.has(child))
          restore.current.set(child, child.inert);
        child.inert = true;
      }
    }
    if (!blocked) {
      for (const [child, inert] of restore.current) child.inert = inert;
      restore.current.clear();
    }
  }, [gate, stage]);
  React.useLayoutEffect(() => {
    const root = stage.current;
    if (
      typeof HTMLElement === "undefined" ||
      !(root instanceof HTMLElement) ||
      typeof root.addEventListener !== "function"
    )
      return;
    const fence = (event: Event) => {
      if (gate.allowed()) return;
      if (event.cancelable) event.preventDefault();
      event.stopImmediatePropagation();
    };
    const events = [
      "click",
      "auxclick",
      "pointerdown",
      "keydown",
      "beforeinput",
      "input",
      "change",
      "paste",
      "cut",
      "drop",
      "submit",
    ];
    events.forEach((name) => root.addEventListener(name, fence, true));
    const unsubscribe = gate.subscribe(apply);
    apply();
    const restored = restore.current;
    return () => {
      unsubscribe();
      events.forEach((name) => root.removeEventListener(name, fence, true));
      for (const [child, inert] of restored) child.inert = inert;
      restored.clear();
    };
  }, [apply, gate, stage]);
  // A queued render may replace a child while the command is still pending.
  React.useLayoutEffect(apply);
}
