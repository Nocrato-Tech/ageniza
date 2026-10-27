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
    expect(sent[0]?.text).toContain('https://app.ageniza.example/senha/redefinir?token=token%20with%20%2B%20and%20%2F');
    expect(sent[0]?.text).toContain('&invite=unused-invite-token');
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

  it('waits for administrative invitation delivery and builds the invitation templates', async () => {
    const sent: OutgoingEmail[] = [];
    const sender = senderFor(async (message) => { sent.push(message); });
    const service = createEmailService({ sender, config, logger: createLogger({ enabled: false }) });

    await service.sendCollaboratorInvitation({
      to: 'person@example.com',
      actionUrl: 'https://app.ageniza.example/convite/invite-token',
      expiresInMinutes: 7 * 1_440,
      agencyName: 'Ageniza'
    });
    await service.sendClientInvitation({
      to: 'person@example.com',
      actionUrl: 'https://app.ageniza.example/convite/client-token',
      expiresInMinutes: 1_440,
      agencyName: 'Ageniza',
      clientName: 'Cliente A'
    });

    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatchObject({ template: 'collaborator-invitation', to: 'person@example.com' });
    expect(sent[0]?.text).toContain('7 dias');
    expect(sent[1]).toMatchObject({ template: 'client-invitation', to: 'person@example.com' });
    expect(sent[1]?.text).toContain('Cliente A');
  });

  it('propagates administrative delivery failures so routes can return 502', async () => {
    const service = createEmailService({
      sender: senderFor(async () => { throw new Error('SMTP rejected invitation token'); }),
      config,
      logger: createLogger({ enabled: false })
    });

    await expect(service.sendCollaboratorInvitation({
      to: 'person@example.com',
      actionUrl: 'https://app.ageniza.example/convite/invite-token',
      expiresInMinutes: 60,
      agencyName: 'Ageniza'
    })).rejects.toThrow('SMTP rejected invitation token');
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
