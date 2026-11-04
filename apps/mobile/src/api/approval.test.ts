import { describe, expect, it, vi } from 'vitest';
import { createApprovalClient } from './approval';

const token = 'a'.repeat(43);
describe('isolated approval session', () => {
  it('keeps only its own cookie in memory and never sends it to account routes', async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('{}', { headers: { 'set-cookie': `ageniza_approval=${token}; Path=/api/portal-approval; HttpOnly` } })).mockResolvedValue(new Response('{}'));
    const client = createApprovalClient('https://dev.ageniza.com.br/api', true, transport);
    await client.request('/portal-approval/session', { method: 'POST', body: { token } });
    await client.request('/portal-approval/batch');
    expect(new Headers(transport.mock.calls[1][1]?.headers).get('Cookie')).toBe(`ageniza_approval=${token}`);
    expect(new Headers(transport.mock.calls[1][1]?.headers).get('expo-origin')).toBe('ageniza://');
    expect(() => client.request('/auth/session')).toThrow('lote');
    expect(() => client.request('/portal-approval/batch?token=secret')).toThrow('lote');
    await client.clear(); await client.request('/portal-approval/batch');
    expect(new Headers(transport.mock.calls[2][1]?.headers).has('Cookie')).toBe(false);
  });
  it('does not adopt a login cookie or reuse the session in another client instance', async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { headers: { 'set-cookie': 'ageniza.session_token=account; HttpOnly' } }));
    const first = createApprovalClient('https://dev.ageniza.com.br/api', true, transport);
    await first.request('/portal-approval/session', { method: 'POST', body: { token } });
    await first.request('/portal-approval/batch');
    await createApprovalClient('https://dev.ageniza.com.br/api', true, transport).request('/portal-approval/batch');
    expect(transport.mock.calls.every(([, options]) => !new Headers(options?.headers).has('Cookie'))).toBe(true);
  });
});
