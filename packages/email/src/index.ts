import { withLogContext, type CoreLogger } from '@ageniza/core';
import nodemailer from 'nodemailer';

export * from './templates.js';
import type { EmailMessage } from './templates.js';

export interface EmailSenderOptions {
  /** `smtp://` or `smtps://` URL; Mailpit locally, the approved provider in production. */
  readonly smtpUrl: string;
  /** Envelope sender, for example `Ageniza <no-reply@example.com>`. */
  readonly from: string;
  readonly logger: CoreLogger;
  readonly timeoutMs?: number;
  /** Test seam: a fake transport avoids any network in unit tests. */
  readonly transport?: EmailTransport;
}

export interface OutgoingEmail extends EmailMessage {
  readonly to: string;
  /** Names the message kind for logs and metrics; never include tokens here. */
  readonly template: string;
}

export interface EmailTransport {
  sendMail(message: { from: string; to: string; subject: string; text: string; html: string }): Promise<{ messageId?: string }>;
}

export interface EmailSender {
  send(email: OutgoingEmail): Promise<void>;
  close(): Promise<void>;
}

const emailAddressPattern = /^[^\s@<>]+@[^\s@<>.]+\.[^\s@<>]+$/;

/** Keeps the domain for troubleshooting while never logging a full recipient address. */
export const maskEmailAddress = (address: string): string => {
  const at = address.lastIndexOf('@');
  if (at <= 0) return '[REDACTED]';
  return `***@${address.slice(at + 1)}`;
};

export const assertEmailAddress = (name: string, value: string): void => {
  const address = value.includes('<') ? value.slice(value.lastIndexOf('<') + 1, value.lastIndexOf('>')) : value;
  if (!emailAddressPattern.test(address.trim())) throw new Error(`${name} must be an email address.`);
};

export const createEmailSender = (options: EmailSenderOptions): EmailSender => {
  assertEmailAddress('Email sender address', options.from);
  const protocol = new URL(options.smtpUrl).protocol;
  if (protocol !== 'smtp:' && protocol !== 'smtps:') throw new Error('Email transport URL must use smtp or smtps.');

  const timeoutMs = options.timeoutMs ?? 10_000;
  const transport: EmailTransport = options.transport ?? nodemailer.createTransport({
    url: options.smtpUrl,
    connectionTimeout: timeoutMs,
    greetingTimeout: timeoutMs,
    socketTimeout: timeoutMs
  });
  const logger = withLogContext(options.logger, { module: 'email' });

  return {
    async send(email: OutgoingEmail): Promise<void> {
      assertEmailAddress('Email recipient', email.to);
      const startedAt = performance.now();
      try {
        // Only the subject-less envelope metadata is logged: never the body, link, or token.
        const result = await transport.sendMail({
          from: options.from,
          to: email.to,
          subject: email.subject,
          text: email.text,
          html: email.html
        });
        logger.info({
          operation: 'email.send',
          status: 'sent',
          template: email.template,
          recipient: maskEmailAddress(email.to),
          messageId: result.messageId,
          durationMs: Math.round(performance.now() - startedAt)
        }, 'Transactional email sent');
      } catch (error) {
        logger.error({
          operation: 'email.send',
          status: 'failed',
          template: email.template,
          recipient: maskEmailAddress(email.to),
          durationMs: Math.round(performance.now() - startedAt)
        }, 'Transactional email failed');
        throw error instanceof Error ? error : new Error('Transactional email failed.');
      }
    },
    async close(): Promise<void> {
      const closable = transport as { close?: () => void };
      closable.close?.();
    }
  };
};
