import type { ApiClient } from '../api/client';

export async function logoutLocally(api: ApiClient, expire: () => void) {
  let revocationFailed = false;
  try { await api.request('/auth/logout', { method: 'POST' }); }
  catch { revocationFailed = true; }
  finally {
    try { await api.clearSession(); }
    finally { expire(); }
  }
  return { revocationFailed };
}
