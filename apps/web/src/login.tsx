import { useEffect, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import {
  AuthLoginRequestSchema,
  AuthLoginResponseSchema,
  ContextResolveResponseSchema
} from '@ageniza/contracts';
import { Button, Field, TextInput, useFormErrors } from '@ageniza/ui';

import { useAuthSession, useAuthSessionStore } from './auth.js';
import { AuthMessage, AuthPanel } from './auth-layout.js';
import { contextDestination, contextTarget, rememberContext, targetFromDestination } from './context-destination.js';
import { useDocumentTitle } from './document-title.js';
import { ResendVerification } from './email-verification.js';
import { validateForm } from './forms.js';
import { forgetGoogleInvite, GOOGLE_REFUSED_MESSAGE, GoogleSignInBlock } from './google-sign-in.js';
import { HttpClientError, useApiClient } from './http.js';
import { sessionDestination } from './session-end.js';

/** Wrong password and unknown e-mail answer the same 401, so the screen shows one sentence for both. */
const INVALID_CREDENTIALS_MESSAGE = 'E-mail ou senha incorretos.';
const LOGIN_FAILED = 'Não foi possível entrar. Tente de novo.';
const RESOLVE_FAILED = 'Não foi possível carregar seus contextos. Tente de novo.';

/**
 * `/entrar` and the chain that decides where the person goes: `POST /auth/login` ->
 * `GET /me/contexts/resolve` -> enter goes to the context, select to `/contextos`, none to
 * `/comecar`. The screen obeys the resolve; it never recomputes the decision.
 *
 * The session is published (`refresh`) only after the destination is known, so the app never
 * renders the workspace before the resolve decides. When the login carries an `inviteToken`, the
 * resolve is skipped: the zero-context session has to survive until the invitation is accepted
 * (specs/auth.md rule 3a). A destination kept by the session guard (#71) wins over enter/select.
 */
export function LoginPage() {
  const httpClient = useApiClient();
  // No error summary here: the login has two fields, and the focus on the first invalid one is enough (decision 2026-10-16).
  const { formRef } = useFormErrors();
  const navigate = useNavigate();
  const authStore = useAuthSessionStore();
  const session = useAuthSession(authStore);
  const location = useLocation();
  const [searchParams] = useSearchParams();
  // `/entrar?erro=google`: where the API sends every refusal of the Google sign-in, with no reason in the address.
  const googleRefused = searchParams.get('erro') === 'google';
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<{ email?: string; password?: string }>({});
  const [formError, setFormError] = useState<string | undefined>();
  const [resolveError, setResolveError] = useState<string | undefined>();
  const [submitting, setSubmitting] = useState(false);
  // Set after any refused credential: the API answers an unconfirmed account like a wrong password
  // (security review of PR #722), so the screen always offers the new link and never says which it was.
  const [refusedEmail, setRefusedEmail] = useState<string | undefined>();
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

  /** Runs the resolve and navigates; a failure is repeatable on its own, without the password again. */
  const runResolve = async (): Promise<void> => {
    setResolveError(undefined);
    setResolving(true);
    try {
      const resolve = await httpClient.request({ path: '/me/contexts/resolve', response: ContextResolveResponseSchema });
      await authStore.refresh();
      // A confirmed account with no context keeps its session and goes to `/comecar` (2026-10-26).
      if (resolve.decision === 'none') { navigate('/comecar', { replace: true }); return; }
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

  // The trip to Google ended in a refusal (the person cancelled there, for one): the invitation kept for it is not for a later visit.
  useEffect(() => { if (googleRefused) forgetGoogleInvite(); }, [googleRefused]);

  // A valid session opening `/entrar` goes to the active context (specs/auth.md, "Já autenticado").
  useEffect(() => {
    if (authenticating || session.status !== 'ready' || !session.isAuthenticated) return;
    void runResolve();
  }, [authenticating, session.status, session.isAuthenticated]);

  const onSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setFormError(undefined);
    setResolveError(undefined);
    setRefusedEmail(undefined);
    const validation = validateForm(AuthLoginRequestSchema, {
      email,
      password,
      ...(inviteToken === undefined ? {} : { inviteToken })
    });
    if (!validation.success) {
      // The password rule at sign-in is "not empty": its length is the rule of creating one, and a wrong one is the server's 401.
      setErrors({
        email: validation.errors.email === undefined ? undefined : 'Informe um e-mail válido.',
        password: validation.errors.password === undefined ? undefined : 'Informe a sua senha.'
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
      else if (error instanceof HttpClientError && error.status === 401) { setFormError(INVALID_CREDENTIALS_MESSAGE); setRefusedEmail(validation.data.email); }
      else setFormError(LOGIN_FAILED);
      return;
    } finally {
      setSubmitting(false);
    }
    // A password sign-in is the way in the person took: what was kept for a trip to Google does not outlive it.
    forgetGoogleInvite();
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

  return <AuthPanel titleId="login-title" title="Entrar" lead="A pauta da sua agência está te esperando.">
    {notice !== undefined && <AuthMessage tone="success" role="status">{notice}</AuthMessage>}
    {googleRefused && formError === undefined && <AuthMessage tone="danger" role="alert">{GOOGLE_REFUSED_MESSAGE}</AuthMessage>}
    <form ref={formRef} className="auth-form" onSubmit={onSubmit} noValidate>
      <Field label="E-mail" id="login-email" error={errors.email}>
        {(control) => <TextInput
          {...control}
          name="email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />}
      </Field>
      <div className="auth-field-link">
        <Field label="Senha" id="login-password" error={errors.password}>
          {(control) => <TextInput
            {...control}
            name="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />}
        </Field>
        <Link className="auth-field-link__link" to="/senha/esquecida" state={inviteToken === undefined ? undefined : { inviteToken }}>Esqueci minha senha</Link>
      </div>
      {resolveError !== undefined && <div role="alert" className="auth-retry">
        <AuthMessage tone="danger">{resolveError}</AuthMessage>
        <Button variant="secondary" className="auth-submit" onClick={() => { void runResolve(); }} loading={resolving}>Tentar de novo</Button>
      </div>}
      {formError !== undefined && <AuthMessage tone="danger" role="alert">{formError}</AuthMessage>}
      <Button type="submit" className="auth-submit" loading={submitting}>Entrar</Button>
      {/* The invitation crosses the trip to Google in this tab and is accepted on the way back, on its own screen. */}
      <GoogleSignInBlock {...(inviteToken === undefined ? {} : { inviteToken })} />
      <p className="auth-note">Ainda não tem conta? <Link to="/criar-conta">Criar conta</Link></p>
    </form>
    {refusedEmail !== undefined && <ResendVerification email={refusedEmail} idPrefix="login" lead="Criou a conta e não confirmou?" buttonLabel="Reenviar o link de confirmação" />}
  </AuthPanel>;
}
