import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  AuthLogoutResponseSchema,
  ContextResolveResponseSchema,
  InvitationAcceptNewAccountRequestSchema,
  InvitationAcceptNewAccountResponseSchema,
  InvitationAcceptResponseSchema,
  InvitationPreviewResponseSchema
} from '@ageniza/contracts';
import { Button, FieldMessage, LiveStatus, Skeleton, TextInput } from '@ageniza/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { useAuthSession, useAuthSessionStore } from './auth.js';
import { useDocumentTitle } from './document-title.js';
import { validateForm } from './forms.js';
import { HttpClientError, useApiClient } from './http.js';

const INVITATION_INVALID = 'Este convite não é mais válido';
const ACCEPT_FAILED = 'Não foi possível aceitar o convite. Tente de novo.';
const RESOLVE_FAILED = 'O convite foi aceito, mas não foi possível carregar seus contextos. Tente de novo.';

/**
 * `/convite/:token`, one route with two states chosen by `accountExists` of `GET /invitations/:token`
 * (specs/auth.md section 7). Nothing of the invitation appears until the API validates the token.
 * The login with `inviteToken` and the acceptance happen before any `resolve` (decisions 2026-09-29,
 * rule 3a): the zero-context session has to survive until the invitation is accepted.
 */
export function InvitationPage() {
  const { token = '' } = useParams();
  const httpClient = useApiClient();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const authStore = useAuthSessionStore();
  const session = useAuthSession(authStore);
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [errors, setErrors] = useState<{ name?: string; password?: string }>({});
  const [formError, setFormError] = useState<string | undefined>();
  const [resolveError, setResolveError] = useState<string | undefined>();
  const [mismatch, setMismatch] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [resolving, setResolving] = useState(false);
  useDocumentTitle('Convite — Ageniza');

  const preview = useQuery({
    queryKey: ['invitation', token],
    queryFn: () => httpClient.request({ path: `/invitations/${encodeURIComponent(token)}`, response: InvitationPreviewResponseSchema })
  });

  /** The acceptance succeeded; only the resolve is left, and it is repeatable on its own. */
  const runResolve = async (): Promise<void> => {
    setResolveError(undefined);
    setResolving(true);
    try {
      const resolve = await httpClient.request({ path: '/me/contexts/resolve', response: ContextResolveResponseSchema });
      if (resolve.decision === 'none') { authStore.end(); queryClient.clear(); navigate('/sem-acesso', { replace: true }); return; }
      navigate(resolve.decision === 'select' ? '/contextos' : '/app', { replace: true });
    } catch {
      setResolveError(RESOLVE_FAILED);
    } finally {
      setResolving(false);
    }
  };

  const routeAfterAccept = async (): Promise<void> => {
    setAccepted(true);
    // The new session may belong to a different account; drop the previous account's cache first.
    queryClient.clear();
    await authStore.refresh();
    await runResolve();
  };

  const accept = useMutation({
    mutationFn: () => httpClient.request({ path: `/invitations/${encodeURIComponent(token)}/accept`, method: 'POST', response: InvitationAcceptResponseSchema }),
    onSuccess: () => routeAfterAccept(),
    onError: (error: unknown) => {
      if (error instanceof HttpClientError && error.status === 403 && error.code === 'INVITATION_ACCOUNT_MISMATCH') { setMismatch(true); return; }
      if (error instanceof HttpClientError && error.status === 410) { setAccepted(false); void preview.refetch(); return; }
      setFormError(ACCEPT_FAILED);
    }
  });

  const createAccount = useMutation({
    mutationFn: (body: { name: string; password: string; acceptTerms: true }) =>
      httpClient.request({ path: `/invitations/${encodeURIComponent(token)}/accept-new-account`, method: 'POST', body, response: InvitationAcceptNewAccountResponseSchema }),
    onSuccess: () => routeAfterAccept(),
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

  // Once the invitation is accepted, the preview no longer matters: show the resolve stage.
  if (accepted) {
    return <section className="form-panel" aria-labelledby="invite-title">
      <h1 id="invite-title">Você foi convidado</h1>
      {resolveError === undefined
        ? <LiveStatus>Entrando…</LiveStatus>
        : <div role="alert">
          <p>{resolveError}</p>
          <Button onClick={() => { void runResolve(); }} loading={resolving}>Tentar de novo</Button>
        </div>}
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

  return <section className="form-panel" aria-labelledby="invite-title">
    <h1 id="invite-title">Você foi convidado</h1>
    <dl className="invite-details">
      <dt>Agência</dt><dd>{agency.name}</dd>
      {client !== null && <><dt>Cliente</dt><dd>{client.name}</dd></>}
      <dt>Convite enviado para</dt><dd>{email}</dd>
    </dl>

    {accountExists
      ? mismatch
        ? <div role="alert">
          <p>Você está conectado com outra conta. Entre com o e-mail do convite.</p>
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
