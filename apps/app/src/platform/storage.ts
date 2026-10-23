/** Small values (identity, profile, settings). */
export interface KeyValue {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

/** Every event this device keeps, one JSON per line, only ever appended. */
export interface EventLog {
  append(text: string): Promise<void>;
  read(): Promise<string>;
  clear(): Promise<void>;
}

/** Exposed by apps/desktop/preload.js: files on disk, written immediately. */
const storeBridge = (globalThis as { munStore?: KeyValue }).munStore;
const logBridge = (globalThis as { munLog?: EventLog }).munLog;

// A plain browser (UI preview only) falls back to localStorage.
const LOG_KEY = 'mun:events';
const local: KeyValue = {
  get: async (key) => globalThis.localStorage?.getItem(key) ?? null,
  set: async (key, value) => globalThis.localStorage?.setItem(key, value),
  remove: async (key) => globalThis.localStorage?.removeItem(key),
};

export const kv: KeyValue = storeBridge ?? local;

export const eventLog: EventLog = logBridge ?? {
  append: async (text) => local.set(LOG_KEY, ((await local.get(LOG_KEY)) ?? '') + text),
  read: async () => (await local.get(LOG_KEY)) ?? '',
  clear: () => local.remove(LOG_KEY),
};
