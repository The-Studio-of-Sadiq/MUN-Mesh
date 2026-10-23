import * as DocumentPicker from 'expo-document-picker';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import type { PickedFile } from '../session';

/** Lets the person choose a file. Null if they cancel. */
export async function pickFile(): Promise<PickedFile | null> {
  const res = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true, multiple: false });
  const asset = res.canceled ? null : res.assets[0];
  if (!asset) return null;
  const data = await new File(asset.uri).bytes();
  return { name: asset.name, mime: asset.mimeType ?? '', data };
}

/** Opens the share sheet for a received file, so it can be opened or saved with another app. */
export async function saveFile(name: string, mime: string, data: Uint8Array): Promise<void> {
  const safe = name.replace(/[\\/:*?"<>|]/g, '_');
  const file = new File(Paths.cache, safe);
  if (file.exists) file.delete();
  file.create();
  await file.write(data);
  await Sharing.shareAsync(file.uri, { mimeType: mime || undefined, dialogTitle: safe });
}
