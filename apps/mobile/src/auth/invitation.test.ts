import { describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../api/client';
import type { InvitationPreviewResponse } from '@ageniza/contracts';
import { acceptInvitation, invitationPreferredContext } from './invitation';

const preview: InvitationPreviewResponse = { purpose: 'collaborator_invite', email: 'person@example.test', agency: { name: 'Agência' }, client: null, accountExists: true };
const fields = { name: 'Pessoa convidada', password: 'a-long-test-password', confirmation: 'a-long-test-password', accepted: true };
const context = { agencyId: 'agency', clientId: null };
function setup() { const request = vi.fn(); return { request, api: { request } as unknown as ApiClient }; }
describe('invitation acceptance', () => {
  it('signs in as the invited address before accepting and preserves the invited context', async () => {
    const { request, api } = setup(); request.mockResolvedValueOnce({ user: { email: preview.email } }).mockResolvedValueOnce({ context });
    expect(await acceptInvitation(api, 'one', preview, fields)).toEqual(context);
    expect(request.mock.calls).toEqual([
      ['/auth/login', { method: 'POST', body: { email: preview.email, password: fields.password, inviteToken: 'one' } }],
      ['/invitations/one/accept', { method: 'POST' }]
    ]);
    expect(invitationPreferredContext(context)).toBe('agency:agency');
    expect(invitationPreferredContext({ ...context, clientId: 'client' })).toBe('client:client');
  });
  it('does not consume an invitation if login fails or authenticates a different address', async () => {
    const { request, api } = setup(); request.mockRejectedValueOnce(new Error('Senha incorreta.'));
    await expect(acceptInvitation(api, 'one', preview, fields)).rejects.toThrow('Senha incorreta');
    expect(request).toHaveBeenCalledTimes(1);
    request.mockReset().mockResolvedValueOnce({ user: { email: 'other@example.test' } });
    await expect(acceptInvitation(api, 'one', preview, fields)).rejects.toThrow('e-mail');
    expect(request).toHaveBeenCalledTimes(1);
  });
  it.each([{ ...fields, accepted: false }, { ...fields, confirmation: 'different' }, { ...fields, name: '' }, { ...fields, password: 'short', confirmation: 'short' }])('does not create an account with invalid consent or credentials', async (input) => {
    const { request, api } = setup();
    await expect(acceptInvitation(api, 'one', { ...preview, accountExists: false }, input)).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });
  it('creates the invited account without changing the target address or sending a tenant id', async () => {
    const { request, api } = setup(); request.mockResolvedValueOnce({ context });
    await acceptInvitation(api, 'one', { ...preview, accountExists: false }, fields);
    expect(request).toHaveBeenCalledWith('/invitations/one/accept-new-account', { method: 'POST', body: { name: fields.name, password: fields.password, acceptTerms: true } });
  });
});
