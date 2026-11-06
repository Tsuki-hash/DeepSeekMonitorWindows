import React from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { initialQuitRequestState, QuitRequest } from "./quit-request";
import type { QuitInteractionGate } from "./quit-interaction";
import { QuitIntentMailbox } from "./quit-intent";

// One watermark per WebView lifetime, not per effect. Native ack persists the
// consumption for a full renderer reload; StrictEffects shares this instance.
const quitMailbox = new QuitIntentMailbox(
  () => invoke<string | null>("get_pending_quit_intent"),
  (intent) => invoke("acknowledge_quit_intent", { intent }),
);

export function useQuitRequest(
  navigate: (action: () => void) => void,
  interactionGate: QuitInteractionGate,
) {
  const [state, setState] = React.useState(initialQuitRequestState);
  const owner = React.useRef<QuitRequest | null>(null);
  React.useEffect(() => {
    // StrictEffects replay gets a fresh owner. Late registration/command
    // completions from the previous owner cannot publish into this lifecycle.
    const request = new QuitRequest(
      (callback) => listen("quit-requested", callback),
      () => invoke("confirm_quit"),
      navigate,
      setState,
      interactionGate.lock,
      quitMailbox,
      {
        setTimeout: (callback, delay) => window.setTimeout(callback, delay),
        clearTimeout: (timer) => window.clearTimeout(timer),
      },
    );
    owner.current = request;
    request.start();
    return () => {
      request.dispose();
      if (owner.current === request) owner.current = null;
    };
  }, [navigate, interactionGate]);
  return {
    state,
    retryListener: () => owner.current?.retryListener(),
    requestQuit: () => owner.current?.requestQuit(),
  };
}
