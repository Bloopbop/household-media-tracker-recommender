// Backups are a copy of household.db without device-only data (API keys and
// the launch counter). They never include cache.db.

import { exportHousehold, importHousehold, setSetting } from './db';
import { localToday } from './library';

export async function createBackupFile(): Promise<File> {
  const bytes = await exportHousehold();
  return new File([bytes as BlobPart], `household-backup-${localToday()}.sqlite`, { type: 'application/x-sqlite3' });
}

export function canShareFile(file: File): boolean {
  return typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] });
}

export function downloadFile(file: File): void {
  const url = URL.createObjectURL(file);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = file.name;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export async function shareFile(file: File): Promise<boolean> {
  try {
    await navigator.share({ files: [file], title: 'Household media backup' });
    return true;
  } catch (error) {
    // The person closed the share sheet.
    if (error instanceof DOMException && error.name === 'AbortError') return false;
    throw error;
  }
}

export async function recordBackup(): Promise<void> {
  await setSetting('last_backup_at', String(Date.now()));
}

export async function restoreBackup(file: File): Promise<number> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const { titles } = await importHousehold(bytes);
  return titles;
}
