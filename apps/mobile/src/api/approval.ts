import { createApiClient } from './client';
import type { CookieCodec } from './client';

const cookiePattern = /(?:^|,\s*)ageniza_approval=([A-Za-z0-9_-]{43})(?:;|$)/;
const codec: CookieCodec = {
  getCookie: (value) => value && /^ageniza_approval=[A-Za-z0-9_-]{43}$/.test(value) ? value : '',
  getSetCookie: (header) => { const match = cookiePattern.exec(header); if (!match) throw new Error('Sessão de aprovação inválida.'); return `ageniza_approval=${match[1]}`; },
  hasBetterAuthCookies: (header) => cookiePattern.test(header)
};

export function createApprovalClient(baseUrl: string, native: boolean, transport: typeof fetch) {
  let cookie: string | null = null;
  const client = createApiClient(baseUrl, { get: async () => cookie, set: async (value) => { cookie = value; }, clear: async () => { cookie = null; } }, native, codec, transport);
  return {
    request: <T,>(path: string, options?: Parameters<typeof client.request>[1]) => {
      if (!/^\/portal-approval\/(?:session|batch|contents\/[A-Za-z0-9-]+\/(?:approve|request-changes|media\/[A-Za-z0-9-]+\/url(?:\?variant=(?:original|thumbnail))?))$/.test(path)) throw new Error('A sessão de aprovação só acessa o lote do link.');
      return client.request<T>(path, options);
    },
    clear: () => client.clearSession()
  };
}
