import { createHash, randomBytes } from 'node:crypto';

/** Invitation tokens are deliberately long enough to make online guessing impractical. */
export const INVITATION_TOKEN_BYTES = 32;
export const INVITATION_TOKEN_TTL_DAYS = 7;
export const INVITATION_TOKEN_TTL_MS = INVITATION_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1_000;

export interface InvitationToken {
  readonly token: string;
  readonly tokenHash: string;
  readonly expiresAt: Date;
  readonly actionUrl: string;
}

export interface CreateInvitationTokenInput {
  readonly appPublicUrl: string;
  readonly now?: Date;
}

/** Generates the raw value sent to a recipient; callers must never persist this value. */
export const generateInvitationToken = (): string => randomBytes(INVITATION_TOKEN_BYTES).toString('base64url');

/** Hashes a raw token for storage and lookup. The digest is safe to persist. */
export const hashInvitationToken = (token: string): string => createHash('sha256').update(token, 'utf8').digest('hex');

/** Builds the public invitation URL without exposing any token in logs or database values. */
export const invitationLink = (appPublicUrl: string, token: string): string =>
  `${appPublicUrl.replace(/\/+$/, '')}/convite/${token}`;

const assertValidDate = (value: Date): void => {
  if (Number.isNaN(value.getTime())) throw new RangeError('Invitation token timestamp must be a valid date.');
};

/** Creates the raw token, its persistence hash, seven-day expiry, and recipient link together. */
export function createInvitationToken(input: CreateInvitationTokenInput): InvitationToken;
export function createInvitationToken(appPublicUrl: string, now?: Date): InvitationToken;
export function createInvitationToken(inputOrUrl: CreateInvitationTokenInput | string, timestamp?: Date): InvitationToken {
  const appPublicUrl = typeof inputOrUrl === 'string' ? inputOrUrl : inputOrUrl.appPublicUrl;
  const now = new Date(typeof inputOrUrl === 'string' ? (timestamp ?? Date.now()) : (inputOrUrl.now ?? Date.now()));
  assertValidDate(now);

  const token = generateInvitationToken();
  const expiresAt = new Date(now.getTime() + INVITATION_TOKEN_TTL_MS);
  return {
    token,
    tokenHash: hashInvitationToken(token),
    expiresAt,
    actionUrl: invitationLink(appPublicUrl, token)
  };
}
