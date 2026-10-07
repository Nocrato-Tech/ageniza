import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  AuthLogoutResponseSchema,
  InvitationAcceptNewAccountRequestSchema,
  InvitationAcceptNewAccountResponseSchema,
  InvitationAcceptResponseSchema,
  InvitationPreviewResponseSchema,
  type InvitationContext
} from '@ageniza/contracts';
import { Button, FieldMessage, LiveStatus, Skeleton, TextInput } from '@ageniza/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { useAuthSession, useAuthSessionStore } from './auth.js';
import { apiPath } from './api-path.js';
import { contextDestination, rememberContext, type ContextTarget } from './context-destination.js';
import { useDocumentTitle } from './document-title.js';
import { validateForm } from './forms.js';
import { HttpClientError, useApiClient } from './http.js';
import { invitationNoticeState } from './invitation-notice.js';

const INVITATION_INVALID = 'Este convite não é mais válido';
const ACCEPT_FAILED = 'Não foi possível aceitar o convite. Tente de novo.';

/**
 * `/convite/:token`, one route with two states chosen by `accountExists` of `GET /invitations/:token`
 * (specs/auth.md section 7). Nothing of the invitation appears until the API validates the token.
 * The login with `inviteToken` and the acceptance happen before any `resolve` (decisions 2026-09-29,
 * rule 3a): the zero-context session has to survive until the invitation is accepted. A login that
 * carried the token lands here with `inviteLogin`: when the authenticated account is the invited
 * one the acceptance runs on its own; when it is another account nothing is accepted and the screen
 * explains the mismatch (decisions 2026-10-07). The destination is the accepted context itself, the
 * one the accept response carries — never the context the session would resolve (decisions 2026-10-07).
 */
export function InvitationPage() {
  const { token = '' } = useParams();
  const httpClient = useApiClient();
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const authStore = useAuthSessionStore();
  const session = useAuthSession(authStore);
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [errors, setErrors] = useState<{ name?: string; password?: string }>({});
  const [formError, setFormError] = useState<string | undefined>();
  const [mismatch, setMismatch] = useState(false);
  const [accepted, setAccepted] = useState(false);
  // Only the navigation state can arm the automatic acceptance. It must never come from the URL:
  // /convite/<token>?inviteLogin=… is a link anyone can send, and accepting on its behalf would be
  // a forced acceptance (security review, PR #317).
  const fromInviteLogin = (location.state as { inviteLogin?: unknown } | null)?.inviteLogin === true;
  const autoAcceptStarted = useRef(false);
  const noticeAgencyName = useRef<string | undefined>(undefined);
  useDocumentTitle('Convite — Ageniza');

  const preview = useQuery({
    queryKey: ['invitation', token],
    queryFn: () => httpClient.request({ path: apiPath('/invitations/:token', { token }), response: InvitationPreviewResponseSchema })
  });

  /** The one-time `already_member` notice, when the acceptance produced one, travels in the state. */
  const noticeState = (): ReturnType<typeof invitationNoticeState> | undefined =>
    noticeAgencyName.current === undefined ? undefined : invitationNoticeState(noticeAgencyName.current);

  /** The accepted context carries the ids the destination and `PUT /me/last-context` need. */
  const invitationTarget = (context: InvitationContext): ContextTarget =>
    context.clientId === null
      ? { type: 'agency', agencyId: context.agencyId }
      : { type: 'client', clientId: context.clientId };

  const routeAfterAccept = async (context: InvitationContext, alreadyMemberAgencyName?: string): Promise<void> => {
    if (alreadyMemberAgencyName !== undefined) noticeAgencyName.current = alreadyMemberAgencyName;
    setAccepted(true);
    // The new session may belong to a different account; drop the previous account's cache first.
    queryClient.clear();
    await authStore.refresh();
    const target = invitationTarget(context);
    await rememberContext(httpClient, target);
    navigate(contextDestination(target), { replace: true, state: noticeState() });
  };

  const accept = useMutation({
    mutationFn: () => httpClient.request({ path: apiPath('/invitations/:token/accept', { token }), method: 'POST', response: InvitationAcceptResponseSchema }),
    onSuccess: (result) => routeAfterAccept(result.context, result.status === 'already_member' ? preview.data?.agency.name : undefined),
    onError: (error: unknown) => {
      if (error instanceof HttpClientError && error.status === 403 && error.code === 'INVITATION_ACCOUNT_MISMATCH') { setMismatch(true); return; }
      if (error instanceof HttpClientError && error.status === 410) { setAccepted(false); void preview.refetch(); return; }
      setFormError(ACCEPT_FAILED);
    }
  });

  // Acceptance after a login that carried the invite token (decisions 2026-10-07): runs once, and
  // only when the authenticated account is the one the invitation was sent to. Another account
  // never accepts; the render below explains the mismatch instead.
  useEffect(() => {
    if (!fromInviteLogin || autoAcceptStarted.current) return;
    if (session.status !== 'ready' || !session.isAuthenticated) return;
    const invitation = preview.data;
    if (invitation === undefined || !invitation.accountExists) return;
    if (invitation.email !== session.user?.email) return;
    autoAcceptStarted.current = true;
    accept.mutate();
  }, [fromInviteLogin, session, preview.data, accept.mutate]);

  const createAccount = useMutation({
    mutationFn: (body: { name: string; password: string; acceptTerms: true }) =>
      httpClient.request({ path: apiPath('/invitations/:token/accept-new-account', { token }), method: 'POST', body, response: InvitationAcceptNewAccountResponseSchema }),
    onSuccess: (result) => routeAfterAccept(result.context),
    onError: (error: unknown) => {
      if (error instanceof HttpClientError && error.status === 410) { void preview.refetch(); return; }
      // The account already exists (created in another tab): show the existing-account state.
      if (error instanceof HttpClientError && error.status === 409 && error.code === 'ACCOUNT_EXISTS') { void preview.refetch(); return; }
      setFormError('Não foi possível criar a conta. Tente de novo.');
    }
  });

  const goToLogin = (): void => {
    navigate('/entrar', {
      state: { inviteToken: token, sessionDestination: { path: `/convite/${encodeURIComponent(token)}`, savedAt: Date.now() } }
    });
  };

  const enterWithAnotherAccount = async (): Promise<void> => {
    if (session.isAuthenticated) {
      try { await httpClient.request({ path: '/auth/logout', method: 'POST', response: AuthLogoutResponseSchema }); } catch { /* best effort */ }
      authStore.end();
      queryClient.clear();
    }
    goToLogin();
  };

  const onSubmitNewAccount = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setFormError(undefined);
    const validation = validateForm(InvitationAcceptNewAccountRequestSchema, { name, password, acceptTerms: acceptedTerms });
    if (!validation.success) {
      setErrors({
        name: validation.errors.name === undefined ? undefined : 'Informe o seu nome.',
        password: validation.errors.password === undefined ? undefined : (password.length > 128 ? 'A senha pode ter no máximo 128 caracteres.' : 'A senha tem no mínimo 10 caracteres.')
      });
      return;
    }
    setErrors({});
    createAccount.mutate(validation.data);
  };

  // Once the invitation is accepted the destination is direct; the accepted context is already known.
  if (accepted) {
    return <section className="form-panel" aria-labelledby="invite-title">
      <h1 id="invite-title">Você foi convidado</h1>
      <LiveStatus>Entrando…</LiveStatus>
    </section>;
  }

  if (preview.isPending) {
    return <section className="form-panel" aria-labelledby="invite-title">
      <h1 id="invite-title">Convite</h1>
      <LiveStatus>Carregando o convite…</LiveStatus>
      <div className="ui-choice-list"><Skeleton /><Skeleton /></div>
    </section>;
  }

  if (preview.isError) {
    const isInvalid = preview.error instanceof HttpClientError && preview.error.status === 410;
    return <section className="form-panel" aria-labelledby="invite-title">
      <h1 id="invite-title">{isInvalid ? INVITATION_INVALID : 'Convite'}</h1>
      {isInvalid
        ? <>
          <p>Convites valem por 7 dias e só podem ser usados uma vez.</p>
          <p>Peça um novo convite a quem administra a agência.</p>
        </>
        : <>
          <p role="alert">Não foi possível carregar o convite.</p>
          <Button onClick={() => { void preview.refetch(); }} disabled={preview.isFetching}>Tentar de novo</Button>
        </>}
    </section>;
  }

  const { agency, client, email, accountExists } = preview.data;
  const connectedWithAnotherAccount = session.user !== null && session.user.email !== email;
  const showMismatch = mismatch || (fromInviteLogin && connectedWithAnotherAccount);

  return <section className="form-panel" aria-labelledby="invite-title">
    <h1 id="invite-title">Você foi convidado</h1>
    <dl className="invite-details">
      <dt>Agência</dt><dd>{agency.name}</dd>
      {client !== null && <><dt>Cliente</dt><dd>{client.name}</dd></>}
      <dt>Convite enviado para</dt><dd>{email}</dd>
    </dl>

    {accountExists
      ? showMismatch
        ? <div role="alert">
          <p>Você está conectado com outra conta. O convite foi enviado para {email}.</p>
          <Button onClick={() => { void enterWithAnotherAccount(); }}>Entrar com outra conta</Button>
        </div>
        : <div className="form-actions">
          <Button
            onClick={() => { if (session.isAuthenticated) accept.mutate(); else goToLogin(); }}
            loading={accept.isPending}
          >Aceitar convite</Button>
          <Button variant="ghost" onClick={() => { void enterWithAnotherAccount(); }}>Entrar com outra conta</Button>
          {formError !== undefined && <p role="alert">{formError}</p>}
        </div>
      : <form className="form-stack" onSubmit={onSubmitNewAccount} noValidate>
        <div className="form-field">
          <label htmlFor="invite-name">Nome</label>
          <TextInput id="invite-name" name="name" autoComplete="name" value={name} onChange={(event) => setName(event.target.value)}
            aria-invalid={errors.name !== undefined} aria-describedby={errors.name === undefined ? undefined : 'invite-name-error'} />
          {errors.name !== undefined && <FieldMessage id="invite-name-error">{errors.name}</FieldMessage>}
        </div>
        <div className="form-field">
          <label htmlFor="invite-password">Senha</label>
          <TextInput id="invite-password" name="password" type="password" autoComplete="new-password" value={password}
            onChange={(event) => setPassword(event.target.value)} aria-invalid={errors.password !== undefined}
            aria-describedby={errors.password === undefined ? 'invite-password-help' : 'invite-password-help invite-password-error'} />
          <p id="invite-password-help" className="form-hint">Mínimo de 10 caracteres</p>
          {errors.password !== undefined && <FieldMessage id="invite-password-error">{errors.password}</FieldMessage>}
        </div>
        <label className="form-check">
          <input type="checkbox" checked={acceptedTerms} onChange={(event) => setAcceptedTerms(event.target.checked)} />
          <span>
            Li e aceito os <Link to="/termos" target="_blank" rel="noreferrer">Termos de Uso</Link> e a{' '}
            <Link to="/privacidade" target="_blank" rel="noreferrer">Política de Privacidade</Link>
          </span>
        </label>
        {formError !== undefined && <p role="alert">{formError}</p>}
        <div className="form-actions">
          <Button type="submit" loading={createAccount.isPending} disabled={!acceptedTerms}>Criar conta e entrar</Button>
        </div>
      </form>}
  </section>;
}
