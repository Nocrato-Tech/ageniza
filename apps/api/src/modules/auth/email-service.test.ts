import { createLogger } from '@ageniza/core';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

import type { EmailSender, OutgoingEmail } from '@ageniza/email';

import { createEmailService } from './email-service.js';

const config = { appPublicUrl: 'https://app.ageniza.example' };

const captureLogs = () => {
  const stream = new PassThrough();
  const lines: string[] = [];
  stream.on('data', (chunk: Buffer) => lines.push(chunk.toString('utf8')));
  return { logger: createLogger({ level: 'info' }, stream), lines };
};

const senderFor = (send: EmailSender['send']): EmailSender => ({
  send,
  close: async () => undefined
});

describe('auth email service', () => {
  it('builds the reset link from the supplied token and schedules delivery', async () => {
    const sent: OutgoingEmail[] = [];
    const sender = senderFor(async (message) => {
      sent.push(message);
    });
    const service = createEmailService({ sender, config, logger: createLogger({ enabled: false }) });

    service.sendPasswordReset({ to: 'person@example.com', token: 'token with + and /', inviteToken: 'unused-invite-token' });
    await service.drain();

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      to: 'person@example.com',
      template: 'password-reset',
      subject: 'Redefina sua senha do Ageniza'
    });
    expect(sent[0]?.text).toContain('https://app.ageniza.example/reset-password?token=token%20with%20%2B%20and%20%2F');
    expect(sent[0]?.text).not.toContain('unused-invite-token');
  });

  it('returns before a slow sender settles and drains it during shutdown', async () => {
    let release!: () => void;
    const send = vi.fn(() => new Promise<void>((resolve) => {
      release = resolve;
    }));
    const service = createEmailService({ sender: senderFor(send), config, logger: createLogger({ enabled: false }) });

    service.sendPasswordReset({ to: 'person@example.com', token: 'reset-token' });
    expect(send).toHaveBeenCalledTimes(1);

    let drained = false;
    const draining = service.shutdown().then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);
    release();
    await draining;
    expect(drained).toBe(true);
  });

  it('handles failures without logging sensitive values', async () => {
    const { logger, lines } = captureLogs();
    const sender = senderFor(async () => {
      throw new Error('SMTP rejected message containing reset-token');
    });
    const service = createEmailService({ sender, config, logger });

    service.sendPasswordReset({ to: 'person@example.com', token: 'reset-token' });
    await service.drain();

    const logged = lines.join('\n');
    expect(logged).toContain('auth.password_reset_email');
    expect(logged).toContain('***@example.com');
    expect(logged).not.toContain('person@example.com');
    expect(logged).not.toContain('reset-token');
    expect(logged).not.toContain('SMTP rejected message');
  });
});
