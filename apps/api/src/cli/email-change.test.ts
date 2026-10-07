import { describe, expect, it } from 'vitest';

import { parseEmailChangeCliArguments } from './email-change.js';

const ID = '11111111-1111-4111-8111-111111111111';

describe('email-change CLI arguments', () => {
  it('parses list, approve (with and without the ownership flag) and reject', () => {
    expect(parseEmailChangeCliArguments(['list'])).toEqual({ command: 'list' });
    expect(parseEmailChangeCliArguments(['approve', '--request-id', ID])).toEqual({ command: 'approve', requestId: ID, ownershipConfirmed: false });
    expect(parseEmailChangeCliArguments(['approve', '--ownership-confirmed', '--request-id', ID])).toEqual({ command: 'approve', requestId: ID, ownershipConfirmed: true });
    expect(parseEmailChangeCliArguments(['approve', `--request-id=${ID}`, '--ownership-confirmed'])).toEqual({ command: 'approve', requestId: ID, ownershipConfirmed: true });
    expect(parseEmailChangeCliArguments(['reject', '--request-id', ID])).toEqual({ command: 'reject', requestId: ID });
  });

  it('never lets the ownership flag reach a command that does not take it', () => {
    expect(() => parseEmailChangeCliArguments(['reject', '--request-id', ID, '--ownership-confirmed'])).toThrow('Unexpected argument');
    expect(() => parseEmailChangeCliArguments(['list', '--ownership-confirmed'])).toThrow('Unexpected argument');
  });

  it('refuses what it does not understand', () => {
    for (const argv of [
      [],
      ['approve'],
      ['approve', '--request-id'],
      ['approve', '--request-id', '--ownership-confirmed'],
      ['approve', '--request-id', ID, '--request-id', ID],
      ['approve', '--request-id', ID, '--ownership-confirmed', '--ownership-confirmed'],
      ['approve', '--user-id', ID],
      ['approve', ID],
      ['delete', '--request-id', ID],
      ['list', 'extra']
    ]) {
      expect(() => parseEmailChangeCliArguments(argv), argv.join(' ')).toThrow();
    }
  });
});
