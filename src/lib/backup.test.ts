import { describe, expect, it } from 'vitest';
import { canShareFile, shareFile, ShareRefusedError, sharesOnlyKnownTypes } from './backup';

const file = new File([new Uint8Array([1, 2, 3])], 'household-backup-2026-11-18.sqlite', {
  type: 'application/x-sqlite3',
});
const chromium = { brands: [{ brand: 'Chromium' }, { brand: 'Google Chrome' }, { brand: 'Not?A_Brand' }] };
const samsung = { brands: [{ brand: 'Chromium' }, { brand: 'Samsung Internet' }] };

describe('offering Share for a backup', () => {
  it('is not offered in Chromium browsers, whose canShare() says yes but share() refuses the file', () => {
    expect(sharesOnlyKnownTypes({ userAgentData: chromium })).toBe(true);
    expect(canShareFile(file, { userAgentData: chromium, canShare: () => true })).toBe(false);
    expect(canShareFile(file, { userAgentData: samsung, canShare: () => true })).toBe(false);
  });

  it('follows canShare() in other browsers', () => {
    expect(canShareFile(file, { canShare: () => true })).toBe(true);
    expect(canShareFile(file, { canShare: () => false })).toBe(false);
    expect(canShareFile(file, { userAgentData: { brands: [{ brand: 'Other' }] }, canShare: () => true })).toBe(true);
  });

  it('is not offered when the browser cannot share at all', () => {
    expect(canShareFile(file, {})).toBe(false);
  });
});

describe('sharing a backup', () => {
  const sharing = (outcome: () => Promise<void>) => ({ share: outcome });

  it('resolves true once shared', async () => {
    await expect(shareFile(file, sharing(() => Promise.resolve()))).resolves.toBe(true);
  });

  it('resolves false when the share sheet is closed', async () => {
    const closed = sharing(() => Promise.reject(new DOMException('Share canceled', 'AbortError')));
    await expect(shareFile(file, closed)).resolves.toBe(false);
  });

  it('explains a refusal and points to saving the file instead', async () => {
    const refused = sharing(() => Promise.reject(new DOMException('Permission denied', 'NotAllowedError')));
    const error = await shareFile(file, refused).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(ShareRefusedError);
    expect((error as Error).message).toBe('This phone does not allow sharing this kind of file. Use “Save the file” instead.');
  });

  it('passes other failures through unchanged', async () => {
    const failed = sharing(() => Promise.reject(new TypeError('Bad data')));
    await expect(shareFile(file, failed)).rejects.toThrow('Bad data');
  });
});
