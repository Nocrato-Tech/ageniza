import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import { createAuthSessionStore } from './auth.js';

const createClient = () => {
  const unsubscribe = vi.fn();
  const getSession = vi.fn().mockResolvedValue({ data: { session: null }, error: null });
  const onAuthStateChange = vi.fn().mockReturnValue({ data: { subscription: { unsubscribe } } });
  const client = { auth: { getSession, onAuthStateChange } } as unknown as SupabaseClient;
  return { client, getSession, onAuthStateChange, unsubscribe };
};

describe('auth session store', () => {
  it('can unsubscribe and subscribe again under React Strict Mode lifecycle replay', () => {
    const { client, onAuthStateChange, unsubscribe } = createClient();
    const store = createAuthSessionStore(client);

    const firstCleanup = store.subscribe(() => undefined);
    firstCleanup();
    const secondCleanup = store.subscribe(() => undefined);

    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(onAuthStateChange).toHaveBeenCalledTimes(2);
    secondCleanup();
    expect(unsubscribe).toHaveBeenCalledTimes(2);
  });

  it('surfaces session lookup failures to the transport boundary', async () => {
    const { client, getSession } = createClient();
    getSession.mockResolvedValueOnce({ data: { session: null }, error: new Error('session storage failed') });

    await expect(createAuthSessionStore(client).getAccessToken()).rejects.toThrow('session storage failed');
  });
});
