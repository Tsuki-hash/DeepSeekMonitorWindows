export const invoke = (command: string, args?: unknown) =>
  globalThis.__settingsIpc(command, args);
export const isTauri = () => true;
export const getVersion = () => Promise.resolve("1.3.1");
export const listen = (name: string, callback: (event: unknown) => void) => {
  const handlers = globalThis.__settingsListeners.get(name) ?? new Set();
  globalThis.__settingsListeners.set(name, handlers);
  handlers.add(callback);
  return Promise.resolve(() => handlers.delete(callback));
};
