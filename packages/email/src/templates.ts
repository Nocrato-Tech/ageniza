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

const notice = (subject: string, lines: readonly string[]): EmailMessage => ({
  subject,
  text: lines.join('\n\n'),
  html: lines.map((line) => `<p>${escapeHtml(line)}</p>`).join('\n')
});

/** To the address the account has now, when someone asks to change it. Carries no link. */
export const emailChangeRequestedEmail = (): EmailMessage =>
  notice('Pediram a troca do e-mail da sua conta no Ageniza', [
    'Pediram a troca do e-mail desta conta no Ageniza.',
    'Se não foi você, troque a senha: na tela de entrada, use "Esqueci a senha".'
  ]);

/** To the NEW address, once the operation approved the request. */
export const emailChangeConfirmationEmail = (input: ActionEmailInput): EmailMessage =>
  compose('Confirme o novo e-mail da sua conta no Ageniza', [
    'A troca do e-mail da sua conta no Ageniza foi aprovada.',
    'Abra o link abaixo para confirmar este endereço como o novo e-mail da conta.'
  ], input);

/** To the OLD address, after the swap. */
export const emailChangedEmail = (): EmailMessage =>
  notice('O e-mail da sua conta no Ageniza foi alterado', [
    'O e-mail desta conta no Ageniza foi alterado e todas as sessões foram encerradas.',
    'Se não foi você, fale com a operação do Ageniza.'
  ]);

export interface ContentNotificationItem {
  /** Free text of the agency: escaped in the HTML, and never trusted anywhere. */
  readonly title: string;
  /** The planned date, `YYYY-MM-DD`, or null. */
  readonly publishOn: string | null;
}

export interface ClientContentEmailInput {
  readonly agencyName: string;
  readonly clientName: string;
  /** The portal of the client: a link without any token, since the person signs in to open it. */
  readonly portalUrl: string;
  readonly items: readonly ContentNotificationItem[];
}

// A header must be one line, and the names that go into it are free text of the agency. \p{Cf} takes the invisible format
// marks too: a bidi override such as U+202E reorders what the reader sees, so a name can read as another one.
const oneLine = (value: string): string => value.replace(/[\p{Cc}\p{Cf}\u2028\u2029]+/gu, ' ').trim();

const formatPlannedDate = (publishOn: string | null): string | undefined => {
  const match = publishOn === null ? null : /^(\d{4})-(\d{2})-(\d{2})$/.exec(publishOn);
  return match === null ? undefined : `${match[3]}/${match[2]}/${match[1]}`;
};

const countOf = (count: number): string => count === 1 ? 'um conteúdo' : `${count} conteúdos`;

const clientContentEmail = (subject: string, introduction: string, invitation: string, input: ClientContentEmailInput): EmailMessage => {
  assertDisplayName('O nome da agência', input.agencyName);
  assertDisplayName('O nome do cliente', input.clientName);
  assertHttpsUrl(input.portalUrl);
  if (input.items.length === 0) throw new Error('O e-mail precisa de ao menos um conteúdo.');
  const lines = input.items.map((item) => {
    const date = formatPlannedDate(item.publishOn);
    return date === undefined ? oneLine(item.title) : `${oneLine(item.title)} (${date})`;
  });
  return {
    subject,
    text: [introduction, lines.map((line) => `- ${line}`).join('\n'), `${invitation}\n${input.portalUrl}`].join('\n\n'),
    html: [
      `<p>${escapeHtml(introduction)}</p>`,
      `<ul>${lines.map((line) => `<li>${escapeHtml(line)}</li>`).join('')}</ul>`,
      `<p>${escapeHtml(invitation)}</p>`,
      `<p><a href="${escapeHtml(input.portalUrl)}">${escapeHtml(input.portalUrl)}</a></p>`
    ].join('\n')
  };
};

/** "Contents to approve": one e-mail per person and client, with everything the agency sent in the burst. */
export const contentsAwaitingApprovalEmail = (input: ClientContentEmailInput): EmailMessage => {
  const agencyName = oneLine(input.agencyName);
  const clientName = oneLine(input.clientName);
  return clientContentEmail(
    `${countOf(input.items.length)} para você aprovar: ${clientName}`,
    `${agencyName} enviou ${countOf(input.items.length)} de ${clientName} para a sua aprovação.`,
    'Abra o portal para aprovar ou pedir ajuste:',
    input
  );
};

/** The daily summary of what the agency published. */
export const contentsPublishedEmail = (input: ClientContentEmailInput): EmailMessage => {
  const agencyName = oneLine(input.agencyName);
  const clientName = oneLine(input.clientName);
  return clientContentEmail(
    `${countOf(input.items.length)} publicado${input.items.length === 1 ? '' : 's'}: ${clientName}`,
    `${agencyName} publicou ${countOf(input.items.length)} de ${clientName}.`,
    'Veja no portal:',
    input
  );
};
