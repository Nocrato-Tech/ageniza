import { captureUnexpectedError, type CoreLogger } from '@ageniza/core';
import { maskEmailAddress, passwordResetEmail, type EmailSender } from '@ageniza/email';

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

export interface EmailService {
  /** Schedules delivery and returns without waiting for the email transport. */
  sendPasswordReset(input: SendPasswordResetInput): void;
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
        actionUrl: actionUrlFor(options.config.appPublicUrl, input.token),
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
    drain,
    shutdown: drain
  };
};
