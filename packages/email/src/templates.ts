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

export type NamedActionEmailInput = Omit<ActionEmailInput, 'agencyName'> & {
  readonly agencyName: string;
};

export type ClientInvitationEmailInput = NamedActionEmailInput & {
  readonly clientName: string;
};

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
    throw new Error('A URL da ação do e-mail deve ser válida.');
  }
  // Loopback keeps local development usable; everything else must be HTTPS.
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
    throw new Error('A URL da ação do e-mail deve usar HTTPS.');
  }
};

const assertPositiveExpiry = (expiresInMinutes: number): void => {
  if (!Number.isInteger(expiresInMinutes) || expiresInMinutes <= 0) {
    throw new Error('A validade do e-mail deve ser um número inteiro positivo de minutos.');
  }
};

const assertDisplayName = (field: string, value: string): void => {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 256) {
    throw new Error(`${field} deve ser um nome não vazio de até 256 caracteres.`);
  }
};

const formatExpiry = (expiresInMinutes: number): string =>
  expiresInMinutes >= 1_440
    ? `Este link expira em ${Math.ceil(expiresInMinutes / 1_440)} ${Math.ceil(expiresInMinutes / 1_440) === 1 ? 'dia' : 'dias'}.`
    : `Este link expira em ${expiresInMinutes} minutos.`;

const compose = (subject: string, lines: readonly string[], input: ActionEmailInput): EmailMessage => {
  assertHttpsUrl(input.actionUrl);
  assertPositiveExpiry(input.expiresInMinutes);
  const closing = `${formatExpiry(input.expiresInMinutes)} Se você não esperava este e-mail, ignore-o.`;
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
  agencyName === undefined ? 'Você foi convidado para o Ageniza.' : `Você foi convidado para ${agencyName} no Ageniza.`;

export const invitationEmail = (input: ActionEmailInput): EmailMessage =>
  compose('Convite para o Ageniza', [invitedBy(input.agencyName), 'Abra o link abaixo para ativar sua conta.'], input);

export const agencyActivationEmail = (input: NamedActionEmailInput): EmailMessage => {
  assertDisplayName('O nome da agência', input.agencyName);
  return compose('Ative sua agência no Ageniza', [
    `Sua agência ${input.agencyName} está quase pronta.`,
    'Abra o link abaixo para ativá-la.'
  ], input);
};

export const collaboratorInvitationEmail = (input: NamedActionEmailInput): EmailMessage => {
  assertDisplayName('O nome da agência', input.agencyName);
  return compose('Convite para participar da agência', [
    `Você foi convidado para participar da ${input.agencyName}.`,
    'Abra o link abaixo para aceitar o convite.'
  ], input);
};

export const clientInvitationEmail = (input: ClientInvitationEmailInput): EmailMessage => {
  assertDisplayName('O nome da agência', input.agencyName);
  assertDisplayName('O nome do cliente', input.clientName);
  return compose('Convite para acessar seu cliente', [
    `Você foi convidado para acessar ${input.clientName}, gerenciado pela ${input.agencyName}.`,
    'Abra o link abaixo para aceitar o convite.'
  ], input);
};

export const emailVerificationEmail = (input: ActionEmailInput): EmailMessage =>
  compose('Confirme seu e-mail no Ageniza', ['Confirme este e-mail para concluir a configuração da sua conta.'], input);

export const passwordResetEmail = (input: ActionEmailInput): EmailMessage =>
  compose('Redefina sua senha do Ageniza', ['Abra o link abaixo para escolher uma nova senha.'], input);
