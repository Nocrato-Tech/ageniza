import { describe, expect, it, vi } from 'vitest';
import type { Context } from '@ageniza/contracts';
import type { ApiClient } from '../api/client';
import { resolveEntry, selectContext } from './session';

const agency: Context = { type: 'agency', agencyId: 'one', agencyName: 'Agência Um', isOwner: true, roleKey: 'admin', roleName: 'Admin' };
function client(responses: unknown[]) {
  const request = vi.fn(async () => responses.shift());
  return { request, clearSession: vi.fn(), onExpired: vi.fn() } as unknown as ApiClient;
}
const session = { emailVerified: true };
const legal = { required: false, documents: [] };
describe('entry follows the server decision', () => {
  it('enters only after the server confirms last-context', async () => {
    const api = client([session, legal, { decision: 'enter', context: agency }, undefined]);
    expect(await resolveEntry(api)).toEqual({ kind: 'active', context: agency });
    expect(api.request).toHaveBeenLastCalledWith('/me/last-context', { method: 'PUT', body: { type: 'agency', agencyId: 'one' } });
  });
  it('does not navigate when switching context is refused', async () => {
    const api = client([]); vi.mocked(api.request).mockRejectedValueOnce(new Error('Acesso removido.'));
    await expect(selectContext(api, agency)).rejects.toThrow('Acesso removido.');
  });
  it('does not resolve contexts before email confirmation or required legal acceptance', async () => {
    const unverified = client([{ emailVerified: false }]);
    await expect(resolveEntry(unverified)).rejects.toThrow('Confirme seu e-mail');
    expect(unverified.request).toHaveBeenCalledTimes(1);
    const pending = client([session, { required: true, documents: [{ document: 'terms', pending: true }] }]);
    expect(await resolveEntry(pending)).toMatchObject({ kind: 'legal' }); expect(pending.request).toHaveBeenCalledTimes(2);
  });
  it.each([{ decision: 'none' }, { decision: 'select', contexts: [agency] }])('handles $decision without choosing another context', async (decision) => {
    const api = client([session, legal, decision]); const result = await resolveEntry(api);
    expect(result.kind).toBe(decision.decision === 'none' ? 'empty' : 'contexts');
    expect(api.request).toHaveBeenCalledTimes(3);
  });
});
