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
const RESOLVE_FAILED = 'Não foi possível carregar seus contextos. Tente de novo.';

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
  const [notice, setNotice] = useState<string | undefined>();
  useDocumentTitle('Convite — Ageniza');

  const preview = useQuery({
    queryKey: ['invitation', token],
    queryFn: () => httpClient.request({ path: `/invitations/${encodeURIComponent(token)}`, response: InvitationPreviewResponseSchema })
  });

  /** After acceptance the session exists; only then the resolve decides the destination. */
  const routeAfterAccept = async (alreadyMember: boolean): Promise<void> => {
    if (alreadyMember) setNotice('Você já tinha acesso a este espaço.');
    await authStore.refresh();
    try {
      const resolve = await httpClient.request({ path: '/me/contexts/resolve', response: ContextResolveResponseSchema });
      if (resolve.decision === 'none') { authStore.end(); queryClient.clear(); navigate('/sem-acesso', { replace: true }); return; }
      navigate(resolve.decision === 'select' ? '/contextos' : '/app', { replace: true });
    } catch {
      setFormError(RESOLVE_FAILED);
    }
  };

  const accept = useMutation({
    mutationFn: () => httpClient.request({ path: `/invitations/${encodeURIComponent(token)}/accept`, method: 'POST', response: InvitationAcceptResponseSchema }),
    onSuccess: (result) => routeAfterAccept(result.status === 'already_member'),
    onError: () => setFormError('Não foi possível aceitar o convite. Tente de novo.')
  });

  const createAccount = useMutation({
    mutationFn: (body: { name: string; password: string; acceptTerms: true }) =>
      httpClient.request({ path: `/invitations/${encodeURIComponent(token)}/accept-new-account`, method: 'POST', body, response: InvitationAcceptNewAccountResponseSchema }),
    onSuccess: () => routeAfterAccept(false),
    onError: (error: unknown) => {
      if (error instanceof HttpClientError && error.status === 410) { void preview.refetch(); return; }
      setFormError('Não foi possível criar a conta. Tente de novo.');
    }
  });

  const goToLogin = (): void => {
    navigate('/entrar', {
      state: { inviteToken: token, sessionDestination: { path: `/convite/${token}`, savedAt: Date.now() } }
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
        password: validation.errors.password === undefined ? undefined : 'A senha tem no mínimo 10 caracteres.'
      });
      return;
    }
    setErrors({});
    createAccount.mutate(validation.data);
  };

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
    {notice !== undefined && <p role="status">{notice}</p>}

    {accountExists
      ? <div className="form-actions">
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
            aria-describedby="invite-password-help" />
          <p id="invite-password-help" className="form-hint">Mínimo de 10 caracteres</p>
          {errors.password !== undefined && <FieldMessage>{errors.password}</FieldMessage>}
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
