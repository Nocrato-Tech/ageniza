import { createHash, randomBytes } from 'node:crypto';

import { PORTAL_APPROVAL_TOKEN_PATTERN } from '@ageniza/contracts';

import { APPROVAL_COOKIE_NAME } from './policy.js';

const TOKEN_BYTES = 32;

/** The raw value goes to the person (the e-mail, the cookie) and is never stored: the database keeps this digest. */
export const hashApprovalToken = (token: string): string => createHash('sha256').update(token, 'utf8').digest('hex');

/** The value of the session cookie: 32 random bytes in base64url, the same shape as the token of the link. */
export const generateApprovalSessionToken = (): string => randomBytes(TOKEN_BYTES).toString('base64url');

/** The token of the session in the `Cookie` header, or `undefined` when it is absent or malformed (a malformed one never reaches the database). */
export const approvalSessionTokenOf = (cookieHeader: string | undefined): string | undefined => {
  if (cookieHeader === undefined) return undefined;
  for (const part of cookieHeader.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== APPROVAL_COOKIE_NAME) continue;
    const value = part.slice(separator + 1).trim();
    return PORTAL_APPROVAL_TOKEN_PATTERN.test(value) ? value : undefined;
  }
  return undefined;
};

export interface ApprovalCookieOptions {
  readonly path: string;
  readonly secure: boolean;
}

/** `HttpOnly`, `SameSite=Strict`, restricted to the routes of the link, and as short as the session. */
export const serializeApprovalCookie = (token: string, maxAgeSeconds: number, options: ApprovalCookieOptions): string =>
  [
    `${APPROVAL_COOKIE_NAME}=${token}`,
    `Path=${options.path}`,
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
    'HttpOnly',
    'SameSite=Strict',
    ...(options.secure ? ['Secure'] : [])
  ].join('; ');
