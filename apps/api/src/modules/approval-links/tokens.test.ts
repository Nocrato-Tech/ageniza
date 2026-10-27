import { createHash } from 'node:crypto';

import { PORTAL_APPROVAL_TOKEN_PATTERN } from '@ageniza/contracts';
import { describe, expect, it } from 'vitest';

import { APPROVAL_COOKIE_NAME, approvalCookieOptions } from './policy.js';
import { approvalSessionTokenOf, generateApprovalSessionToken, hashApprovalToken, serializeApprovalCookie } from './tokens.js';

const TOKEN = 'x9Qm2L0vWk3pTz8RjYb4Nc7HsAe1UdFgO5iXqKrMtV6';

describe('the tokens and the cookie of the approval link (issue #712)', () => {
  it('hashes with sha256 in hex, and generates 32 random bytes in the shape the contract accepts', () => {
    expect(hashApprovalToken(TOKEN)).toBe(createHash('sha256').update(TOKEN, 'utf8').digest('hex'));
    expect(hashApprovalToken(TOKEN)).toMatch(/^[0-9a-f]{64}$/);
    const generated = new Set(Array.from({ length: 50 }, () => generateApprovalSessionToken()));
    expect(generated.size).toBe(50);
    for (const token of generated) expect(token).toMatch(PORTAL_APPROVAL_TOKEN_PATTERN);
  });

  it('reads the session from the Cookie header among other cookies, and nothing else', () => {
    expect(approvalSessionTokenOf(`${APPROVAL_COOKIE_NAME}=${TOKEN}`)).toBe(TOKEN);
    expect(approvalSessionTokenOf(`a=1; ${APPROVAL_COOKIE_NAME}=${TOKEN}; b=2`)).toBe(TOKEN);
    expect(approvalSessionTokenOf(`  ${APPROVAL_COOKIE_NAME} = ${TOKEN} `)).toBe(TOKEN);
    expect(approvalSessionTokenOf(undefined)).toBeUndefined();
    expect(approvalSessionTokenOf('a=1; b=2')).toBeUndefined();
    expect(approvalSessionTokenOf(`x${APPROVAL_COOKIE_NAME}=${TOKEN}`)).toBeUndefined();
    expect(approvalSessionTokenOf(`${APPROVAL_COOKIE_NAME}x=${TOKEN}`)).toBeUndefined();
  });

  it.each([
    ['empty', ''],
    ['short', 'abc'],
    ['long', `${TOKEN}A`],
    ['with a character outside base64url', `${TOKEN.slice(0, 42)}+`],
    ['with padding', `${TOKEN.slice(0, 42)}=`],
    ['with a space inside', `${TOKEN.slice(0, 20)} ${TOKEN.slice(21)}`],
    ['with a semicolon', `${TOKEN.slice(0, 42)};`]
  ])('does not take a session value that is %s: it never reaches the database', (_name, value) => {
    expect(approvalSessionTokenOf(`${APPROVAL_COOKIE_NAME}=${value}`)).toBeUndefined();
  });

  it('serializes HttpOnly, SameSite=Strict, a path, a Max-Age and no domain; Secure only where the app is https', () => {
    const plain = serializeApprovalCookie(TOKEN, 7_199.6, { path: '/portal-approval', secure: false });
    expect(plain).toBe(`${APPROVAL_COOKIE_NAME}=${TOKEN}; Path=/portal-approval; Max-Age=7199; HttpOnly; SameSite=Strict`);
    expect(plain).not.toContain('Secure');
    const secure = serializeApprovalCookie(TOKEN, 60, { path: '/api/portal-approval', secure: true });
    expect(secure).toBe(`${APPROVAL_COOKIE_NAME}=${TOKEN}; Path=/api/portal-approval; Max-Age=60; HttpOnly; SameSite=Strict; Secure`);
    expect(secure).not.toContain('Domain');
    expect(serializeApprovalCookie(TOKEN, -5, { path: '/p', secure: false })).toContain('Max-Age=0');
  });

  it('restricts the cookie to the path the browser sees, which is the path of the public address of the API (#737)', () => {
    expect(approvalCookieOptions('https://app.example.test/api')).toEqual({ path: '/api/portal-approval', secure: true });
    expect(approvalCookieOptions('http://127.0.0.1:3001')).toEqual({ path: '/portal-approval', secure: false });
    // A trailing slash, or several, change nothing; a deeper path is kept whole.
    expect(approvalCookieOptions('https://app.example.test/api/')).toEqual({ path: '/api/portal-approval', secure: true });
    expect(approvalCookieOptions('http://127.0.0.1:3001/')).toEqual({ path: '/portal-approval', secure: false });
    expect(approvalCookieOptions('https://app.example.test/v1/api//')).toEqual({ path: '/v1/api/portal-approval', secure: true });
  });
});
