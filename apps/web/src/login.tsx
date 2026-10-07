import { useEffect, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import {
  AuthLoginRequestSchema,
  AuthLoginResponseSchema,
  ContextResolveResponseSchema
} from '@ageniza/contracts';
import { Button, FieldMessage, TextInput } from '@ageniza/ui';
import { useQueryClient } from '@tanstack/react-query';

import { useAuthSession, useAuthSessionStore } from './auth.js';
import { contextDestination, contextTarget, rememberContext, targetFromDestination } from './context-destination.js';
import { useDocumentTitle } from './document-title.js';
import { validateForm } from './forms.js';
import { HttpClientError, useApiClient } from './http.js';
import { sessionDestination } from './session-end.js';

/** Wrong password and unknown e-mail answer the same 401, so the screen shows one sentence for both. */
const INVALID_CREDENTIALS_MESSAGE = 'E-mail ou senha incorretos.';
const LOGIN_FAILED = 'Não foi possível entrar. Tente de novo.';
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
  const [resolveError, setResolveError] = useState<string | undefined>();
  const [submitting, setSubmitting] = useState(false);
  const [resolving, setResolving] = useState(false);
  // While the chain runs the login screen owns the redirect; the session must not drive it yet.
  const [authenticating, setAuthenticating] = useState(false);
  useDocumentTitle('Entrar — Ageniza');

  const state = location.state as { inviteToken?: unknown } | null;
  const inviteToken = typeof state?.inviteToken === 'string' ? state.inviteToken : undefined;
  const notice = typeof (location.state as { notice?: unknown } | null)?.notice === 'string'
    ? (location.state as { notice: string }).notice
    : undefined;
  const destination = sessionDestination(location.state);

  /**
   * The server already ended the session for a `none` resolve, and a 403 never created one, so
   * there is nothing to revoke: drop the client session and the cache, then navigate. Calling
   * `logout` here would answer 401 without a session and trigger the session-ended redirect.
   */
  const leaveToNoAccess = (): void => {
    authStore.end();
    queryClient.clear();
    navigate('/sem-acesso', { replace: true });
  };

  /** Runs the resolve and navigates; a failure is repeatable on its own, without the password again. */
  const runResolve = async (): Promise<void> => {
    setResolveError(undefined);
    setResolving(true);
    try {
      const resolve = await httpClient.request({ path: '/me/contexts/resolve', response: ContextResolveResponseSchema });
      if (resolve.decision === 'none') { leaveToNoAccess(); return; }
      await authStore.refresh();
      if (resolve.decision === 'enter') {
        // Entering a context records it as the last one; the destination carries the agency or
        // client id, never `/app` (docs/business/decisions.md, 2026-09-29). When a saved
        // destination (#71) wins, the context recorded is the one of that destination, not the one
        // `resolve` picked -- otherwise the next login would enter a context the person never used.
        const target = destination ?? contextDestination(resolve.context);
        const remembered = destination === null ? contextTarget(resolve.context) : targetFromDestination(destination);
        if (remembered !== null) await rememberContext(httpClient, remembered);
        navigate(target, { replace: true });
        return;
      }
      navigate(destination ?? '/contextos', { replace: true });
    } catch {
      setResolveError(RESOLVE_FAILED);
    } finally {
      setResolving(false);
    }
  };

  // A valid session opening `/entrar` goes to the active context (specs/auth.md, "Já autenticado").
  useEffect(() => {
    if (authenticating || session.status !== 'ready' || !session.isAuthenticated) return;
    void runResolve();
  }, [authenticating, session.status, session.isAuthenticated]);

  const onSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setFormError(undefined);
    setResolveError(undefined);
    const validation = validateForm(AuthLoginRequestSchema, {
      email,
      password,
      ...(inviteToken === undefined ? {} : { inviteToken })
    });
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
        body: validation.data,
        response: AuthLoginResponseSchema
      });
    } catch (error: unknown) {
      // The login itself failed: the message is about entering, never about loading contexts.
      setAuthenticating(false);
      if (error instanceof HttpClientError && error.status === 429) setFormError('Muitas tentativas. Tente novamente mais tarde.');
      else if (error instanceof HttpClientError && error.status === 403 && error.code === 'NO_CONTEXT_ACCESS') leaveToNoAccess();
      else if (error instanceof HttpClientError && error.status === 401) setFormError(INVALID_CREDENTIALS_MESSAGE);
      else setFormError(LOGIN_FAILED);
      return;
    } finally {
      setSubmitting(false);
    }
    if (inviteToken !== undefined) {
      // Rule 3a: a zero-context session created for an invitation must not call resolve, which
      // would end it before the invitation is accepted. Go back to the invitation instead,
      // marking that the login came from the invite link: the screen accepts on its own when the
      // authenticated account is the invited one (decisions 2026-10-07).
      await authStore.refresh();
      navigate(destination ?? `/convite/${encodeURIComponent(inviteToken)}`, { replace: true, state: { inviteLogin: true } });
      return;
    }
    await runResolve();
  };

  return <section className="form-panel" aria-labelledby="login-title">
    <h1 id="login-title">Ageniza</h1>
    {notice !== undefined && <p role="status">{notice}</p>}
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
      {resolveError !== undefined && <div role="alert">
        <p>{resolveError}</p>
        <Button onClick={() => { void runResolve(); }} loading={resolving}>Tentar de novo</Button>
      </div>}
      {formError !== undefined && <p role="alert">{formError}</p>}
      <div className="form-actions">
        <Button type="submit" loading={submitting}>Entrar</Button>
        <Link to="/senha/esquecida" state={inviteToken === undefined ? undefined : { inviteToken }}>Esqueci minha senha</Link>
        <p>O acesso ao Ageniza é por convite.</p>
      </div>
    </form>
  </section>;
}
