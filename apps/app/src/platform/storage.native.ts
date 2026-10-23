import AsyncStorage from '@react-native-async-storage/async-storage';
import { Directory, File, Paths } from 'expo-file-system';
import type { ChunkStore } from '@mun/core';
import type { EventLog, KeyValue } from './storage';

export type { EventLog, KeyValue } from './storage';

export const kv: KeyValue = {
  get: (key) => AsyncStorage.getItem(key),
  set: (key, value) => AsyncStorage.setItem(key, value),
  remove: (key) => AsyncStorage.removeItem(key),
};

// A file, not AsyncStorage: the log grows to megabytes and Android caps a row at 2 MB.
const logFile = () => new File(Paths.document, 'events.ndjson');

export const eventLog: EventLog = {
  async append(text) {
    const file = logFile();
    if (!file.exists) file.create();
    await file.write(text, { append: true });
  },
  async read() {
    const file = logFile();
    return file.exists ? file.text() : '';
  },
  async clear() {
    const file = logFile();
    if (file.exists) file.delete();
  },
};

const chunkDir = () => {
  const dir = new Directory(Paths.document, 'chunks');
  if (!dir.exists) dir.create({ idempotent: true, intermediates: true });
  return dir;
};

/** One file per chunk, named by its id (base64url, so safe as a file name). */
export const chunkStore: ChunkStore = {
  async list() {
    return chunkDir()
      .list()
      .filter((e): e is File => e instanceof File)
      .map((f) => f.name);
  },
  async get(id) {
    const file = new File(chunkDir(), id);
    return file.exists ? file.bytes() : null;
  },
  async put(id, data) {
    const file = new File(chunkDir(), id);
    if (!file.exists) file.create();
    await file.write(data);
  },
};

export async function clearChunks(): Promise<void> {
  const dir = new Directory(Paths.document, 'chunks');
  if (dir.exists) dir.delete();
}
