import type { Pool } from 'pg';
import { getOAuthState } from 'better-auth/api';
import { verifyGoogleIdToken, type GoogleProfile } from 'better-auth/social-providers';

import type { CoreLogger } from '@ageniza/core';

/** The nonce rides the state record the callback reads back, so it cannot be set by the browser. */
export const GOOGLE_NONCE_KEY = 'googleNonce';

/** How long a Google sign-in counts as the proof an account without a password gives where a password is asked. */
export const GOOGLE_REAUTH_WINDOW_MS = 5 * 60 * 1_000;

const MAX_NAME_LENGTH = 120;

export interface GoogleUserInfoDependencies {
  readonly clientId: string;
  readonly pool: Pool;
  readonly logger: CoreLogger;
}

export interface GoogleTokens {
  readonly idToken?: string | undefined;
}

/**
 * What Better Auth asks the provider for after the code is exchanged, and the one place every rule of the Google
 * sign-in is held (decision 2026-10-26): the id token must be Google's, for this client and this very flow (the nonce), the
 * address it names must be one Google verified, and the database then decides whether that identity may enter
 * (`app_private.google_sign_in_admission`: the subject names the account, and an unconfirmed account holding the address is
 * taken over). Every refusal returns null and is logged with its reason only, never an address or a token; the caller
 * answers all of them the same way.
 */
export const createGoogleUserInfo = (dependencies: GoogleUserInfoDependencies) =>
  async (token: GoogleTokens) => {
    const refuse = (reason: string): null => {
      dependencies.logger.warn({ operation: 'auth.google_sign_in', status: 'refused', reason }, 'Google sign-in refused');
      return null;
    };

    if (token.idToken === undefined) return refuse('no_id_token');
    const state = (await getOAuthState()) as Record<string, unknown> | null;
    const nonce = state?.[GOOGLE_NONCE_KEY];
    if (typeof nonce !== 'string' || nonce === '') return refuse('no_nonce');

    const claims = await verifyGoogleIdToken({ token: token.idToken, audience: dependencies.clientId, nonce });
    if (claims === null) return refuse('id_token_invalid');
    if (claims.email_verified !== true) return refuse('email_not_verified');
    const { sub, email, name } = claims;
    if (typeof sub !== 'string' || sub === '' || typeof email !== 'string' || email === '') return refuse('claims_incomplete');

    const result = await dependencies.pool.query<{ admitted: boolean }>(
      'select app_private.google_sign_in_admission($1::text, $2::text) as admitted',
      [sub, email]
    );
    if (result.rows[0]?.admitted !== true) return refuse('not_admitted');

    return {
      user: {
        // The profile photo is the product's own (identity storage); Google's picture is not stored.
        name: typeof name === 'string' && name.trim() !== '' ? name.trim().slice(0, MAX_NAME_LENGTH) : email.split('@')[0] ?? email,
        email,
        emailVerified: true
      },
      // The subject is read from here by the provider's `accountSubject`: it, and not the address, names the account.
      data: claims as unknown as GoogleProfile
    };
  };
