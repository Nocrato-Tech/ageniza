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

// A name that goes into a line of text is free text of the agency (the CLI takes it as typed). It is one line, and no invisible
// format mark reorders what the reader sees: a bidi override such as U+202E can make a name read as another one. The zero-width
// joiner (U+200D) and the tags (U+E0020-U+E007F) stay: they hold the family emoji and the flags of subdivisions, which come from
// the title of a content as well.
const oneLine = (value: string): string => value.replace(/(?:[\p{Cc}\u2028\u2029]|(?![\u200D\u{E0020}-\u{E007F}])\p{Cf})+/gu, ' ').trim();

// The name as it goes into the text: checked as typed, then cleaned, and what is left must still be a name.
const displayName = (field: string, value: string): string => {
  assertDisplayName(field, value);
  const clean = oneLine(value);
  assertDisplayName(field, clean);
  return clean;
};

const invitedBy = (agencyName?: string): string =>
  agencyName === undefined ? 'Você foi convidado para o Ageniza.' : `Você foi convidado para ${displayName('O nome da agência', agencyName)} no Ageniza.`;

export const invitationEmail = (input: ActionEmailInput): EmailMessage =>
  compose('Convite para o Ageniza', [invitedBy(input.agencyName), 'Abra o link abaixo para ativar sua conta.'], input);

export const agencyActivationEmail = (input: NamedActionEmailInput): EmailMessage => {
  const agencyName = displayName('O nome da agência', input.agencyName);
  return compose('Ative sua agência no Ageniza', [
    `Sua agência ${agencyName} está quase pronta.`,
    'Abra o link abaixo para ativá-la.'
  ], input);
};

export const collaboratorInvitationEmail = (input: NamedActionEmailInput): EmailMessage => {
  const agencyName = displayName('O nome da agência', input.agencyName);
  return compose('Convite para participar da agência', [
    `Você foi convidado para participar da ${agencyName}.`,
    'Abra o link abaixo para aceitar o convite.'
  ], input);
};

export const clientInvitationEmail = (input: ClientInvitationEmailInput): EmailMessage => {
  const agencyName = displayName('O nome da agência', input.agencyName);
  const clientName = displayName('O nome do cliente', input.clientName);
  return compose('Convite para acessar seu cliente', [
    `Você foi convidado para acessar ${clientName}, gerenciado pela ${agencyName}.`,
    'Abra o link abaixo para aceitar o convite.'
  ], input);
};

/**
 * "Adicionar pessoa": the access is already given, so there is nothing to accept and the link does not expire. It opens the
 * sign-in screen; the person creates an account with this address or enters with the one that has it.
 */
export const clientPortalWelcomeEmail = (input: Omit<ClientInvitationEmailInput, 'expiresInMinutes'>): EmailMessage => {
  const agencyName = displayName('O nome da agência', input.agencyName);
  const clientName = displayName('O nome do cliente', input.clientName);
  assertHttpsUrl(input.actionUrl);
  const lines = [
    `A ${agencyName} deu a você acesso ao portal de ${clientName} no Ageniza.`,
    'Para entrar, crie uma conta com este e-mail ou use a que você já tem.'
  ];
  const closing = 'Se você não esperava este e-mail, ignore-o.';
  return {
    subject: 'Você tem acesso ao portal no Ageniza',
    text: [...lines, input.actionUrl, closing].join('\n\n'),
    html: [
      ...lines.map((line) => `<p>${escapeHtml(line)}</p>`),
      `<p><a href="${escapeHtml(input.actionUrl)}">Entrar no portal</a></p>`,
      `<p>${escapeHtml(closing)}</p>`
    ].join('\n')
  };
};

/** The confirmation of a public sign-up. The link alone confirms nothing: it asks for the account's password. */
export const emailVerificationEmail = (input: ActionEmailInput): EmailMessage =>
  compose('Confirme seu e-mail no Ageniza', [
    'Confirme este e-mail para concluir a criação da sua conta no Ageniza. O link pede a senha que você escolheu.',
    "Se não foi você que criou esta conta, ignore este e-mail. Para usar este endereço, escolha 'Esqueci a senha' na tela de entrada."
  ], input);

/** To an address that already has an account, when someone tries to sign up with it. Carries no link. */
export const signUpWithExistingAccountEmail = (): EmailMessage =>
  notice('Tentaram criar uma conta com o seu e-mail no Ageniza', [
    'Alguém tentou criar uma conta no Ageniza com este e-mail, que já tem uma conta.',
    "Se foi você, entre com a sua senha ou, se não lembra dela, escolha 'Esqueci a senha' na tela de entrada.",
    'Se não foi você, ignore este e-mail: nada mudou na sua conta.'
  ]);

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

/**
 * The e-mail "contents to approve" carries the approval link of the person (issue #712) instead of the portal: it opens the contents of
 * this batch and nothing else, without a login. The token is in the fragment (`#`), which the browser never sends to a server.
 */
export interface ClientApprovalEmailInput {
  readonly agencyName: string;
  readonly clientName: string;
  readonly approvalUrl: string;
  readonly items: readonly ContentNotificationItem[];
}

const formatPlannedDate = (publishOn: string | null): string | undefined => {
  const match = publishOn === null ? null : /^(\d{4})-(\d{2})-(\d{2})$/.exec(publishOn);
  return match === null ? undefined : `${match[3]}/${match[2]}/${match[1]}`;
};

const countOf = (count: number): string => count === 1 ? 'um conteúdo' : `${count} conteúdos`;

const clientContentEmail = (
  subject: string,
  introduction: string,
  invitation: string,
  input: Pick<ClientContentEmailInput, 'agencyName' | 'clientName' | 'items'> & { readonly actionUrl: string; readonly closing?: string }
): EmailMessage => {
  assertDisplayName('O nome da agência', input.agencyName);
  assertDisplayName('O nome do cliente', input.clientName);
  assertHttpsUrl(input.actionUrl);
  if (input.items.length === 0) throw new Error('O e-mail precisa de ao menos um conteúdo.');
  const lines = input.items.map((item) => {
    const date = formatPlannedDate(item.publishOn);
    return date === undefined ? oneLine(item.title) : `${oneLine(item.title)} (${date})`;
  });
  return {
    subject,
    text: [introduction, lines.map((line) => `- ${line}`).join('\n'), `${invitation}\n${input.actionUrl}`, ...(input.closing === undefined ? [] : [input.closing])].join('\n\n'),
    html: [
      `<p>${escapeHtml(introduction)}</p>`,
      `<ul>${lines.map((line) => `<li>${escapeHtml(line)}</li>`).join('')}</ul>`,
      `<p>${escapeHtml(invitation)}</p>`,
      `<p><a href="${escapeHtml(input.actionUrl)}">${escapeHtml(input.actionUrl)}</a></p>`,
      ...(input.closing === undefined ? [] : [`<p>${escapeHtml(input.closing)}</p>`])
    ].join('\n')
  };
};

// The token of an approval link lives in the fragment. A link with a query would carry it to the server, its logs and the proxies,
// and one with no fragment would carry nothing to exchange.
const assertApprovalUrl = (approvalUrl: string): void => {
  assertHttpsUrl(approvalUrl);
  const parsed = new URL(approvalUrl);
  if (parsed.search !== '' || parsed.hash.length < 2) throw new Error('O link de aprovação leva o token no fragmento (#), sem consulta (?).');
};

/** "Contents to approve": one e-mail per person and client, with everything the agency sent in the burst, and the link that approves them. */
export const contentsAwaitingApprovalEmail = (input: ClientApprovalEmailInput): EmailMessage => {
  assertApprovalUrl(input.approvalUrl);
  const agencyName = oneLine(input.agencyName);
  const clientName = oneLine(input.clientName);
  return clientContentEmail(
    `${countOf(input.items.length)} para você aprovar: ${clientName}`,
    `${agencyName} enviou ${countOf(input.items.length)} de ${clientName} para a sua aprovação.`,
    'Abra o link para ver os conteúdos e aprovar ou pedir ajuste:',
    {
      ...input,
      actionUrl: input.approvalUrl,
      closing: 'O link vale por 7 dias e é só seu: quem o abrir pode aprovar ou pedir ajuste em seu nome. Não o encaminhe.'
    }
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
    { ...input, actionUrl: input.portalUrl }
  );
};
