import { describe, expect, it } from 'vitest';
import { parseAccountLink } from './links';

const trusted = 'https://dev.ageniza.com.br';
describe('account links', () => {
  it.each([
    ['ageniza://email/verificar?token=one', 'verify'],
    [`${trusted}/senha/redefinir?token=two`, 'reset'],
    [`${trusted}/convite/abc_123`, 'invitation'],
    ['ageniza://email/confirmar?token=three', 'emailChange']
  ])('accepts the intended action of %s', (url, kind) => {
    expect(parseAccountLink(url, trusted)?.kind).toBe(kind);
  });
  it('accepts approval tokens only in the fragment of the trusted link', () => {
    const token = 'a'.repeat(43);
    expect(parseAccountLink(`${trusted}/aprovar#${token}`, trusted)).toEqual({ kind: 'approval', token });
    expect(parseAccountLink(`${trusted}/aprovar?token=${token}`, trusted)).toBeNull();
    expect(parseAccountLink(`https://evil.example/aprovar#${token}`, trusted)).toBeNull();
  });
  it.each([
    'https://evil.example/email/verificar?token=one',
    'http://dev.ageniza.com.br/email/verificar?token=one',
    'https://dev.ageniza.com.br.evil.example/convite/a',
    'ageniza://email/verificar?token=one&token=two',
    'ageniza://email/verificar?cookie=secret&token=one',
    'ageniza://email/verificar?token=',
    'ageniza://email/verificar?token=one#cookie=secret',
    'javascript:alert(1)'
  ])('refuses foreign, ambiguous or session-bearing links', (url) => {
    expect(parseAccountLink(url, trusted)).toBeNull();
  });
});
