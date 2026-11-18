// Backups are a copy of household.db without device-only data (API keys and
// the launch counter). They never include cache.db.

import { exportHousehold, importHousehold, setSetting } from './db';
import { localToday } from './library';

export async function createBackupFile(): Promise<File> {
  const bytes = await exportHousehold();
  return new File([bytes as BlobPart], `household-backup-${localToday()}.sqlite`, { type: 'application/x-sqlite3' });
}

type ShareNavigator = {
  canShare?: Navigator['canShare'];
  userAgentData?: { brands?: ReadonlyArray<{ brand?: string }> };
};

/**
 * Chromium browsers (Chrome, Samsung Internet, Edge) share only a fixed list of
 * file types: images, audio, video, PDF, plain text and a few more. Their
 * canShare() still says yes for a database file, and share() then fails with
 * "Permission denied", so the app does not offer sharing there.
 */
export function sharesOnlyKnownTypes(nav: ShareNavigator = navigator): boolean {
  return nav.userAgentData?.brands?.some((entry) => entry.brand === 'Chromium') ?? false;
}

export function canShareFile(file: File, nav: ShareNavigator = navigator): boolean {
  if (sharesOnlyKnownTypes(nav)) return false;
  return typeof nav.canShare === 'function' && nav.canShare({ files: [file] });
}

/** The browser refused to share the file; saving it still works. */
export class ShareRefusedError extends Error {
  constructor() {
    super('This phone does not allow sharing this kind of file. Use “Save the file” instead.');
    this.name = 'ShareRefusedError';
  }
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

/** Resolves to false when the person closes the share sheet without sharing. */
export async function shareFile(file: File, nav: Pick<Navigator, 'share'> = navigator): Promise<boolean> {
  try {
    await nav.share({ files: [file], title: 'Household media backup' });
    return true;
  } catch (error) {
    const name = (error as { name?: unknown } | null)?.name;
    if (name === 'AbortError') return false;
    if (name === 'NotAllowedError') throw new ShareRefusedError();
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
