import { useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import {
  AuthLoginRequestSchema,
  AuthLoginResponseSchema,
  ContextResolveResponseSchema
} from '@ageniza/contracts';
import { Button, FieldMessage, TextInput } from '@ageniza/ui';

import { useAuthSessionStore } from './auth.js';
import { useDocumentTitle } from './document-title.js';
import { validateForm } from './forms.js';
import { HttpClientError, useApiClient } from './http.js';

/** Wrong password and unknown e-mail answer the same 401, so the screen shows one sentence for both. */
const INVALID_CREDENTIALS_MESSAGE = 'E-mail ou senha incorretos.';

/**
 * `/entrar` and the chain that decides where the person goes: `POST /auth/login` ->
 * `GET /me/contexts/resolve` -> enter goes to the context, select to `/contextos`, none to the
 * "no access" screen. The screen obeys the resolve; it never recomputes the decision.
 *
 * The optional `inviteToken` arrives through router state (never the URL) so the invitation screen
 * (#76) can create a session for a zero-context account without exposing the token.
 */
export function LoginPage() {
  const httpClient = useApiClient();
  const navigate = useNavigate();
  const authStore = useAuthSessionStore();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<{ email?: string; password?: string }>({});
  const [formError, setFormError] = useState<string | undefined>();
  const [submitting, setSubmitting] = useState(false);
  useDocumentTitle('Entrar — Ageniza');

  const state = location.state as { inviteToken?: unknown } | null;
  const inviteToken = typeof state?.inviteToken === 'string' ? state.inviteToken : undefined;

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
    try {
      await httpClient.request({
        path: '/auth/login',
        method: 'POST',
        body: inviteToken === undefined ? validation.data : { ...validation.data, inviteToken },
        response: AuthLoginResponseSchema
      });
      await authStore.refresh();
      const resolve = await httpClient.request({ path: '/me/contexts/resolve', response: ContextResolveResponseSchema });
      if (resolve.decision === 'select') navigate('/contextos');
      else if (resolve.decision === 'none') { authStore.end(); navigate('/sem-acesso'); }
      else navigate('/app');
    } catch (error: unknown) {
      if (error instanceof HttpClientError && error.status === 429) {
        setFormError('Muitas tentativas. Tente novamente mais tarde.');
      } else if (error instanceof HttpClientError && error.status === 403 && error.code === 'NO_CONTEXT_ACCESS') {
        authStore.end();
        navigate('/sem-acesso');
      } else if (error instanceof HttpClientError && error.status === 401) {
        setFormError(INVALID_CREDENTIALS_MESSAGE);
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
        <Link to="/senha/esquecida">Esqueci minha senha</Link>
        <p>O acesso ao Ageniza é por convite.</p>
      </div>
    </form>
  </section>;
}
