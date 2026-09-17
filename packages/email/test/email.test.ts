import { createLogger } from '@ageniza/core';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

import {
  assertEmailAddress,
  createEmailSender,
  emailVerificationEmail,
  invitationEmail,
  maskEmailAddress,
  passwordResetEmail,
  type EmailTransport
} from '../src/index.js';

const actionUrl = 'https://app.ageniza.example/activate?token=super-secret-token';

const captureLogs = () => {
  const stream = new PassThrough();
  const lines: string[] = [];
  stream.on('data', (chunk: Buffer) => lines.push(chunk.toString('utf8')));
  return { logger: createLogger({ level: 'info' }, stream), lines };
};

const fakeTransport = (): EmailTransport & { sent: Array<Record<string, string>> } => {
  const sent: Array<Record<string, string>> = [];
  return {
    sent,
    async sendMail(message) {
      sent.push(message);
      return { messageId: 'test-message-id' };
    }
  };
};

describe('transactional email templates', () => {
  it('renders invitation, verification, and reset messages with the action link and expiry', () => {
    const invitation = invitationEmail({ actionUrl, expiresInMinutes: 60, agencyName: 'Nocrato' });
    expect(invitation.subject).toContain('Convite');
    expect(invitation.text).toContain('Nocrato');
    expect(invitation.text).toContain(actionUrl);
    expect(invitation.text).toContain('60 minutos');
    expect(emailVerificationEmail({ actionUrl, expiresInMinutes: 30 }).subject).toContain('Confirme');
    expect(passwordResetEmail({ actionUrl, expiresInMinutes: 15 }).subject).toContain('Redefina');
  });

  it('escapes HTML so a crafted name or link cannot inject markup', () => {
    const message = invitationEmail({
      actionUrl: 'https://app.ageniza.example/a?token=x&y=1',
      expiresInMinutes: 10,
      agencyName: '<script>alert(1)</script>'
    });
    expect(message.html).not.toContain('<script>');
    expect(message.html).toContain('&lt;script&gt;');
    expect(message.html).toContain('token=x&amp;y=1');
  });

  it('refuses insecure links and nonsense expiries', () => {
    expect(() => invitationEmail({ actionUrl: 'http://app.ageniza.example/a', expiresInMinutes: 10 })).toThrow('HTTPS');
    expect(() => invitationEmail({ actionUrl: 'not-a-url', expiresInMinutes: 10 })).toThrow('válida');
    expect(() => invitationEmail({ actionUrl: 'http://127.0.0.1:5173/a', expiresInMinutes: 10 })).not.toThrow();
    expect(() => invitationEmail({ actionUrl, expiresInMinutes: 0 })).toThrow('positivo');
  });
});

describe('email sender', () => {
  it('validates the sender address and transport URL', () => {
    const { logger } = captureLogs();
    expect(() => createEmailSender({ smtpUrl: 'smtp://mailpit:1025', from: 'not-an-address', logger })).toThrow('email address');
    expect(() => createEmailSender({ smtpUrl: 'https://example.com', from: 'a@b.co', logger })).toThrow('smtp');
    expect(() => createEmailSender({ smtpUrl: 'smtp://mailpit:1025', from: 'Ageniza <no-reply@ageniza.example>', logger })).not.toThrow();
    expect(() => assertEmailAddress('Recipient', 'user@example.com')).not.toThrow();
    expect(maskEmailAddress('person@example.com')).toBe('***@example.com');
  });

  it('sends through the transport and never logs the link, token, or full recipient', async () => {
    const { logger, lines } = captureLogs();
    const transport = fakeTransport();
    const sender = createEmailSender({ smtpUrl: 'smtp://mailpit:1025', from: 'no-reply@ageniza.example', logger, transport });
    const message = invitationEmail({ actionUrl, expiresInMinutes: 60 });

    await sender.send({ ...message, to: 'person@example.com', template: 'invitation' });
    await sender.close();

    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]?.text).toContain(actionUrl);
    const logged = lines.join('\n');
    expect(logged).toContain('"template":"invitation"');
    expect(logged).toContain('***@example.com');
    expect(logged).not.toContain('super-secret-token');
    expect(logged).not.toContain('person@example.com');
  });

  it('reports failures without leaking the message body', async () => {
    const { logger, lines } = captureLogs();
    const transport: EmailTransport = { sendMail: vi.fn(async () => { throw new Error('smtp refused'); }) };
    const sender = createEmailSender({ smtpUrl: 'smtp://mailpit:1025', from: 'no-reply@ageniza.example', logger, transport });
    const message = passwordResetEmail({ actionUrl, expiresInMinutes: 15 });

    await expect(sender.send({ ...message, to: 'person@example.com', template: 'password-reset' })).rejects.toThrow('smtp refused');
    const logged = lines.join('\n');
    expect(logged).toContain('"status":"failed"');
    expect(logged).not.toContain('super-secret-token');
  });
});
