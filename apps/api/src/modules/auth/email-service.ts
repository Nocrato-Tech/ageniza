import { captureUnexpectedError, type CoreLogger } from '@ageniza/core';
import {
  clientInvitationEmail,
  collaboratorInvitationEmail,
  maskEmailAddress,
  passwordResetEmail,
  type EmailSender
} from '@ageniza/email';

import { invitationLink } from '../invitations/tokens.js';

/** Configuration needed to build links in authentication emails. */
export interface AuthEmailConfig {
  /** Public origin where the web application serves the password reset screen. */
  readonly appPublicUrl: string;
}

export interface SendPasswordResetInput {
  readonly to: string;
  readonly token: string;
  /** Reserved for the invitation flow; password reset does not use it yet. */
  readonly inviteToken?: string;
}

export interface SendInvitationEmailInput {
  readonly to: string;
  /** A complete invitation URL; route callers can pass the URL built by the token primitive. */
  readonly actionUrl?: string;
  /** Convenience input for callers that only hold the raw token. Never persisted or logged. */
  readonly token?: string;
  readonly expiresInMinutes: number;
  readonly agencyName: string;
}

export interface SendClientInvitationEmailInput extends SendInvitationEmailInput {
  readonly clientName: string;
}

export interface EmailService {
  /** Schedules delivery and returns without waiting for the email transport. */
  sendPasswordReset(input: SendPasswordResetInput): void;
  /** Sends an administrative collaborator invitation and waits for SMTP delivery. */
  sendCollaboratorInvitation(input: SendInvitationEmailInput): Promise<void>;
  /** Sends an administrative client invitation and waits for SMTP delivery. */
  sendClientInvitation(input: SendClientInvitationEmailInput): Promise<void>;
  /** Waits for in-flight delivery for at most ten seconds. */
  drain(): Promise<void>;
  /** Alias for drain for shutdown manager integrations. */
  shutdown(): Promise<void>;
}

export interface CreateEmailServiceOptions {
  readonly sender: EmailSender;
  readonly config: AuthEmailConfig;
  readonly logger: CoreLogger;
}

const DRAIN_TIMEOUT_MS = 10_000;
const PASSWORD_RESET_OPERATION = 'auth.password_reset_email';

const actionUrlFor = (appPublicUrl: string, token: string): string =>
  `${appPublicUrl.replace(/\/$/, '')}/reset-password?token=${encodeURIComponent(token)}`;

const resetActionUrlFor = (appPublicUrl: string, token: string, inviteToken?: string): string => {
  const actionUrl = actionUrlFor(appPublicUrl, token);
  if (inviteToken === undefined) return actionUrl;
  return `${actionUrl}&invite=${encodeURIComponent(inviteToken)}`;
};

const invitationActionUrlFor = (appPublicUrl: string, input: SendInvitationEmailInput): string => {
  if (input.actionUrl !== undefined) return input.actionUrl;
  if (input.token !== undefined) return invitationLink(appPublicUrl, input.token);
  throw new Error('A URL do convite é obrigatória.');
};

/**
 * Composes the authentication email boundary. Delivery is deliberately fire-and-forget so a
 * reset request has the same response timing whether an account exists or an SMTP server is slow.
 */
export const createEmailService = (options: CreateEmailServiceOptions): EmailService => {
  const pendingEmails = new Set<Promise<void>>();

  const reportDeliveryFailure = (to: string): void => {
    const telemetry = {
      operation: PASSWORD_RESET_OPERATION,
      status: 'failed' as const,
      recipient: maskEmailAddress(to),
      error: { name: 'EmailDeliveryError', code: 'EMAIL_DELIVERY_FAILED' }
    };
    options.logger.error(telemetry, 'Password reset email delivery failed');

    // Keep the error sent to telemetry generic: SMTP errors can contain recipients or message
    // data, and reset tokens must never leave this boundary.
    try {
      captureUnexpectedError(new Error('Password reset email delivery failed.'), {
        operation: PASSWORD_RESET_OPERATION,
        status: 'failed'
      });
    } catch {
      // Telemetry must not turn a best-effort email into an unhandled rejection.
    }
  };

  const sendInvitation = async (
    input: SendInvitationEmailInput | SendClientInvitationEmailInput,
    message: ReturnType<typeof collaboratorInvitationEmail> | ReturnType<typeof clientInvitationEmail>,
    template: string
  ): Promise<void> => {
    try {
      await options.sender.send({ ...message, to: input.to, template });
    } catch (error) {
      reportDeliveryFailure(input.to);
      throw error;
    }
  };

  const drain = async (): Promise<void> => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((resolve) => {
      timeout = setTimeout(resolve, DRAIN_TIMEOUT_MS);
    });
    try {
      await Promise.race([
        Promise.allSettled([...pendingEmails]).then(() => undefined),
        deadline
      ]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  };

  return {
    sendPasswordReset(input): void {
      const message = passwordResetEmail({
        actionUrl: resetActionUrlFor(options.config.appPublicUrl, input.token, input.inviteToken),
        expiresInMinutes: 30
      });

      let delivery: Promise<void>;
      try {
        delivery = options.sender.send({
          ...message,
          to: input.to,
          template: 'password-reset'
        });
      } catch (error) {
        delivery = Promise.reject(error);
      }

      const trackedDelivery = delivery.catch(() => {
        reportDeliveryFailure(input.to);
      });
      pendingEmails.add(trackedDelivery);
      void trackedDelivery.finally(() => {
        pendingEmails.delete(trackedDelivery);
      }).catch(() => {
        // The rejection is already handled above; keep cleanup detached and safe.
      });
    },
    sendCollaboratorInvitation(input): Promise<void> {
      return sendInvitation(input, collaboratorInvitationEmail({
        actionUrl: invitationActionUrlFor(options.config.appPublicUrl, input),
        expiresInMinutes: input.expiresInMinutes,
        agencyName: input.agencyName
      }), 'collaborator-invitation');
    },
    sendClientInvitation(input): Promise<void> {
      return sendInvitation(input, clientInvitationEmail({
        actionUrl: invitationActionUrlFor(options.config.appPublicUrl, input),
        expiresInMinutes: input.expiresInMinutes,
        agencyName: input.agencyName,
        clientName: input.clientName
      }), 'client-invitation');
    },
    drain,
    shutdown: drain
  };
};
