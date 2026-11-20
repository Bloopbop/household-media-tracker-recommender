// Backups are a copy of household.db without device-only data (API keys and
// the launch counter). They never include cache.db.

import { exportHousehold, importHousehold, mergeHousehold, setSetting } from './db';
import { localToday } from './library';
import type { MergeSummary } from './merge';

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

/**
 * Combines the other phone's backup into this one (merge.ts). With apply
 * false nothing changes, and the summary says what combining would add.
 */
export async function combineBackup(file: File, apply: boolean): Promise<MergeSummary> {
  return mergeHousehold(new Uint8Array(await file.arrayBuffer()), apply);
}

/** "2 titles, 5 ratings and 12 reactions": what a combine adds, in words. Empty when nothing. */
export function describeMerge(summary: MergeSummary): string {
  const parts: [number, string, string][] = [
    [summary.titles, 'new title', 'new titles'],
    [summary.details, 'title with newer details', 'titles with newer details'],
    [summary.ratings, 'rating', 'ratings'],
    [summary.statuses, 'status', 'statuses'],
    [summary.watches, 'watch', 'watches'],
    [summary.notes, 'note', 'notes'],
    [summary.reactions, 'reaction to a pick', 'reactions to picks'],
  ];
  const words = parts.filter(([count]) => count > 0).map(([count, one, many]) => `${count} ${count === 1 ? one : many}`);
  if (words.length === 0) return summary.signals > 0 ? 'records of picks seen on the other phone' : '';
  return words.length === 1 ? words[0] : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}
