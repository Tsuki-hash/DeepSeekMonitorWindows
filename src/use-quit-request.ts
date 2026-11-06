import React from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { initialQuitRequestState, QuitRequest } from "./quit-request";

export function useQuitRequest(navigate: (action: () => void) => void) {
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
    );
    owner.current = request;
    request.start();
    return () => {
      request.dispose();
      if (owner.current === request) owner.current = null;
    };
  }, [navigate]);
  return {
    state,
    retryListener: () => owner.current?.retryListener(),
    requestQuit: () => owner.current?.requestQuit(),
  };
}
