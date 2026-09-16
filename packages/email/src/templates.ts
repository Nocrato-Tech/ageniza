/**
 * Transactional message bodies. Wording is deliberately minimal: the approved invitation,
 * activation, and reset copy comes from the authentication UX specification and lands with the
 * Better Auth work. Links and tokens are values here and must never reach a log.
 */

export interface EmailMessage {
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

export interface ActionEmailInput {
  /** Complete, already-signed URL the recipient must open. */
  readonly actionUrl: string;
  readonly expiresInMinutes: number;
  /** Optional display name of the agency that triggered the message. */
  readonly agencyName?: string;
}

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      default: return '&#39;';
    }
  });

const assertHttpsUrl = (actionUrl: string): void => {
  let parsed: URL;
  try {
    parsed = new URL(actionUrl);
  } catch {
    throw new Error('Email action URL must be a valid URL.');
  }
  // Loopback keeps local development usable; everything else must be HTTPS.
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
    throw new Error('Email action URL must use HTTPS.');
  }
};

const assertPositiveExpiry = (expiresInMinutes: number): void => {
  if (!Number.isInteger(expiresInMinutes) || expiresInMinutes <= 0) {
    throw new Error('Email expiry must be a positive whole number of minutes.');
  }
};

const compose = (subject: string, lines: readonly string[], input: ActionEmailInput): EmailMessage => {
  assertHttpsUrl(input.actionUrl);
  assertPositiveExpiry(input.expiresInMinutes);
  const closing = `This link expires in ${input.expiresInMinutes} minutes. If you did not expect this email, ignore it.`;
  const body = [...lines, input.actionUrl, closing];
  return {
    subject,
    text: body.join('\n\n'),
    html: [
      ...lines.map((line) => `<p>${escapeHtml(line)}</p>`),
      `<p><a href="${escapeHtml(input.actionUrl)}">${escapeHtml(input.actionUrl)}</a></p>`,
      `<p>${escapeHtml(closing)}</p>`
    ].join('\n')
  };
};

const invitedBy = (agencyName?: string): string =>
  agencyName === undefined ? 'You were invited to Ageniza.' : `You were invited to ${agencyName} on Ageniza.`;

export const invitationEmail = (input: ActionEmailInput): EmailMessage =>
  compose('Your Ageniza invitation', [invitedBy(input.agencyName), 'Open the link below to activate your account.'], input);

export const emailVerificationEmail = (input: ActionEmailInput): EmailMessage =>
  compose('Confirm your Ageniza email address', ['Confirm this address to finish setting up your account.'], input);

export const passwordResetEmail = (input: ActionEmailInput): EmailMessage =>
  compose('Reset your Ageniza password', ['Open the link below to choose a new password.'], input);
