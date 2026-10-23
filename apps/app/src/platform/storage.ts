import { MemoryChunkStore, type ChunkStore } from '@mun/core';

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

/** Exposed by apps/desktop/preload.js: one file per chunk on disk. */
interface ChunkBridge {
  list(): Promise<string[]>;
  get(id: string): Promise<Uint8Array | null>;
  put(id: string, data: Uint8Array): Promise<void>;
  clear(): Promise<void>;
}
const chunkBridge = (globalThis as { munChunks?: ChunkBridge }).munChunks;
// A browser preview keeps chunks in memory only.
const memory = new MemoryChunkStore();

export const chunkStore: ChunkStore = chunkBridge ?? memory;

export const clearChunks = async (): Promise<void> => {
  if (chunkBridge) await chunkBridge.clear();
  else memory.data.clear();
};

export const eventLog: EventLog = logBridge ?? {
  append: async (text) => local.set(LOG_KEY, ((await local.get(LOG_KEY)) ?? '') + text),
  read: async () => (await local.get(LOG_KEY)) ?? '',
  clear: () => local.remove(LOG_KEY),
};
