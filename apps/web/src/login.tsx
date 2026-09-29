import { useEffect, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import {
  AuthLoginRequestSchema,
  AuthLoginResponseSchema,
  AuthLogoutResponseSchema,
  ContextResolveResponseSchema
} from '@ageniza/contracts';
import { Button, FieldMessage, TextInput } from '@ageniza/ui';
import { useQueryClient } from '@tanstack/react-query';

import { useAuthSession, useAuthSessionStore } from './auth.js';
import { useDocumentTitle } from './document-title.js';
import { validateForm } from './forms.js';
import { HttpClientError, useApiClient } from './http.js';
import { sessionDestination } from './session-end.js';

/** Wrong password and unknown e-mail answer the same 401, so the screen shows one sentence for both. */
const INVALID_CREDENTIALS_MESSAGE = 'E-mail ou senha incorretos.';
const NO_ACCESS = '/sem-acesso';
const RESOLVE_FAILED = 'Não foi possível carregar seus contextos. Tente de novo.';

/**
 * `/entrar` and the chain that decides where the person goes: `POST /auth/login` ->
 * `GET /me/contexts/resolve` -> enter goes to the context, select to `/contextos`, none to the
 * "no access" screen. The screen obeys the resolve; it never recomputes the decision.
 *
 * The session is published (`refresh`) only after the destination is known, so the app never
 * renders the workspace before the resolve decides. When the login carries an `inviteToken`, the
 * resolve is skipped: the zero-context session has to survive until the invitation is accepted
 * (specs/auth.md rule 3a). A destination kept by the session guard (#71) wins over enter/select.
 */
export function LoginPage() {
  const httpClient = useApiClient();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const authStore = useAuthSessionStore();
  const session = useAuthSession(authStore);
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<{ email?: string; password?: string }>({});
  const [formError, setFormError] = useState<string | undefined>();
  const [submitting, setSubmitting] = useState(false);
  // While the chain runs the login screen owns the redirect; the session must not drive it yet.
  const [authenticating, setAuthenticating] = useState(false);
  useDocumentTitle('Entrar — Ageniza');

  const state = location.state as { inviteToken?: unknown } | null;
  const inviteToken = typeof state?.inviteToken === 'string' ? state.inviteToken : undefined;
  const destination = sessionDestination(location.state);

  /** Ends the session on the server (idempotent) and on the client, clears the cache, goes to no-access. */
  const leaveToNoAccess = async (): Promise<void> => {
    try { await httpClient.request({ path: '/auth/logout', method: 'POST', response: AuthLogoutResponseSchema }); } catch { /* idempotent */ }
    authStore.end();
    queryClient.clear();
    navigate(NO_ACCESS, { replace: true });
  };

  /** Resolves the destination: no context ends the session; a kept destination wins over enter/select. */
  const resolveDestination = async (): Promise<string | null> => {
    const resolve = await httpClient.request({ path: '/me/contexts/resolve', response: ContextResolveResponseSchema });
    if (resolve.decision === 'none') return null;
    if (destination !== null) return destination;
    return resolve.decision === 'select' ? '/contextos' : '/app';
  };

  const enterAfterAuth = async (): Promise<void> => {
    const target = await resolveDestination();
    await authStore.refresh();
    if (target === null) { await leaveToNoAccess(); return; }
    navigate(target, { replace: true });
  };

  // A valid session opening `/entrar` goes to the active context (specs/auth.md, "Já autenticado").
  useEffect(() => {
    if (authenticating || session.status !== 'ready' || !session.isAuthenticated) return;
    let cancelled = false;
    void (async () => {
      try {
        const target = await resolveDestination();
        if (cancelled) return;
        if (target === null) { await leaveToNoAccess(); return; }
        navigate(target, { replace: true });
      } catch {
        if (!cancelled) setFormError(RESOLVE_FAILED);
      }
    })();
    return () => { cancelled = true; };
  }, [authenticating, session.status, session.isAuthenticated]);

  const onSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setFormError(undefined);
    const validation = validateForm(AuthLoginRequestSchema, { email, password });
    if (!validation.success) {
      setErrors({
        email: validation.errors.email === undefined ? undefined : 'Informe um e-mail válido.',
        password: validation.errors.password === undefined ? undefined : 'A senha tem no mínimo 10 caracteres.'
      });
      return;
    }
    setErrors({});
    setSubmitting(true);
    setAuthenticating(true);
    try {
      await httpClient.request({
        path: '/auth/login',
        method: 'POST',
        // `AuthLoginRequestSchema` will carry `inviteToken` once #175 lands; until then the field is
        // sent beside the validated body (the API accepts it).
        body: inviteToken === undefined ? validation.data : { ...validation.data, inviteToken },
        response: AuthLoginResponseSchema
      });
      if (inviteToken !== undefined) {
        // Rule 3a: a zero-context session created for an invitation must not call resolve, which
        // would end it before the invitation is accepted. Go back to the invitation instead.
        await authStore.refresh();
        navigate(destination ?? `/convite/${encodeURIComponent(inviteToken)}`, { replace: true });
        return;
      }
      await enterAfterAuth();
    } catch (error: unknown) {
      setAuthenticating(false);
      if (error instanceof HttpClientError && error.status === 429) {
        setFormError('Muitas tentativas. Tente novamente mais tarde.');
      } else if (error instanceof HttpClientError && error.status === 403 && error.code === 'NO_CONTEXT_ACCESS') {
        authStore.end();
        queryClient.clear();
        navigate(NO_ACCESS, { replace: true });
      } else if (error instanceof HttpClientError && error.status === 401) {
        setFormError(INVALID_CREDENTIALS_MESSAGE);
      } else if (error instanceof HttpClientError) {
        // A resolve that failed after a successful login: keep the person here, with a retry.
        setFormError(RESOLVE_FAILED);
      } else {
        setFormError('Não foi possível entrar. Tente de novo.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  return <section className="form-panel" aria-labelledby="login-title">
    <h1 id="login-title">Ageniza</h1>
    <form className="form-stack" onSubmit={onSubmit} noValidate>
      <div className="form-field">
        <label htmlFor="login-email">E-mail</label>
        <TextInput
          id="login-email"
          name="email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          aria-invalid={errors.email !== undefined}
          aria-describedby={errors.email === undefined ? undefined : 'login-email-error'}
        />
        {errors.email !== undefined && <FieldMessage id="login-email-error">{errors.email}</FieldMessage>}
      </div>
      <div className="form-field">
        <label htmlFor="login-password">Senha</label>
        <TextInput
          id="login-password"
          name="password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          aria-invalid={errors.password !== undefined}
          aria-describedby={errors.password === undefined ? undefined : 'login-password-error'}
        />
        {errors.password !== undefined && <FieldMessage id="login-password-error">{errors.password}</FieldMessage>}
      </div>
      {formError !== undefined && <p role="alert">{formError}</p>}
      <div className="form-actions">
        <Button type="submit" loading={submitting}>Entrar</Button>
        <Link to="/senha/esquecida" state={inviteToken === undefined ? undefined : { inviteToken }}>Esqueci minha senha</Link>
        <p>O acesso ao Ageniza é por convite.</p>
      </div>
    </form>
  </section>;
}
