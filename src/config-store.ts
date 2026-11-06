import type { AppConfig } from "./types";

let current: AppConfig | null = null;
const listeners = new Set<() => void>();

export const getCommittedConfig = () => current;

export const subscribeCommittedConfig = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** Keep committed configuration available across settings-page unmounts. */
export const setCommittedConfig = (config: AppConfig | null) => {
  current = config;
  for (const listener of listeners) listener();
};
