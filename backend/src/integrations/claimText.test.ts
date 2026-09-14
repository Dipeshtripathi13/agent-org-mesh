import { beforeEach, describe, expect, it, vi } from 'vitest';

/** A claim must never silently vanish because the model call failed (end-to-end test,
 *  2026-09-13: a rejected API key dropped every claim and every asker was told "nothing is
 *  disclosable", including the person asking about themselves). */

const provider = { configured: vi.fn(), writeClaim: vi.fn() };
vi.mock('./runtimeProvider.js', () => ({ getMainProvider: vi.fn(async () => ({ provider })) }));
vi.mock('../db/repo.js', () => ({}));

const { claimText } = await import('./realClaims.js');

describe('claimText', () => {
  beforeEach(() => {
    provider.configured.mockReset();
    provider.writeClaim.mockReset();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it("uses the model's sentence when it works", async () => {
    provider.configured.mockReturnValue(true);
    provider.writeClaim.mockResolvedValue('Ben finished the invoice totals.');
    expect(await claimText(1, 'Ben', '- edited invoice.py', 'fallback')).toBe('Ben finished the invoice totals.');
  });

  it('falls back to the plain summary when the model call fails', async () => {
    provider.configured.mockReturnValue(true);
    provider.writeClaim.mockRejectedValue(new Error('This API key is not scoped to a workspace'));
    expect(await claimText(1, 'Ben', '- edited invoice.py', 'Claude Code activity: 1 file touched.')).toBe('Claude Code activity: 1 file touched.');
    expect(console.error).toHaveBeenCalled();
  });

  it('uses the plain summary when no model is configured, without calling one', async () => {
    provider.configured.mockReturnValue(false);
    expect(await claimText(1, 'Ben', 'digest', 'plain')).toBe('plain');
    expect(provider.writeClaim).not.toHaveBeenCalled();
  });
});
