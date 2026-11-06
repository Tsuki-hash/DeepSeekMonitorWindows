import React from "react";
import { listen } from "@tauri-apps/api/event";

/** Completion is an invalidation signal, not a successful-save receipt. A timed
 * out IPC can still finish later, including with an error. Subscribe before the
 * initial read so mounting during that completion cannot miss the final state. */
export function useLocalSettingsRefresh(
  refresh: (generation?: number) => unknown,
) {
  const latest = React.useRef(refresh);
  latest.current = refresh;
  React.useEffect(() => {
    let active = true;
    let generation = -1;
    const refreshCurrent = (next?: number) => {
      if (active) void latest.current(next);
    };
    const listener = listen<number>("local-settings-changed", (event) => {
      if (
        !active ||
        !Number.isSafeInteger(event.payload) ||
        event.payload < 0 ||
        event.payload <= generation
      )
        return;
      generation = event.payload;
      refreshCurrent(generation);
    });
    void listener.then(
      () => refreshCurrent(),
      () => refreshCurrent(),
    );
    return () => {
      active = false;
      void listener.then((off) => off()).catch(() => undefined);
    };
  }, []);
}
