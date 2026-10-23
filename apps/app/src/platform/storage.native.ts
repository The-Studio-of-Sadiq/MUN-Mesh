import AsyncStorage from '@react-native-async-storage/async-storage';
import { File, Paths } from 'expo-file-system';
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
    file.write(text, { append: true });
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
