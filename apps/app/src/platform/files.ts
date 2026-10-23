import * as DocumentPicker from 'expo-document-picker';
import type { PickedFile } from '../session';

/** Lets the person choose a file. Null if they cancel. */
export async function pickFile(): Promise<PickedFile | null> {
  const res = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: false, multiple: false });
  const asset = res.canceled ? null : res.assets[0];
  if (!asset) return null;
  const data = asset.file ? new Uint8Array(await asset.file.arrayBuffer()) : new Uint8Array(await (await fetch(asset.uri)).arrayBuffer());
  return { name: asset.name, mime: asset.mimeType ?? '', data };
}

/** Saves a received file: a download in the Windows app (it asks where). */
export async function saveFile(name: string, mime: string, data: Uint8Array): Promise<void> {
  const url = URL.createObjectURL(new Blob([data as BlobPart], { type: mime || 'application/octet-stream' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
