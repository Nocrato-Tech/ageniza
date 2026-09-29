import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  AuthPasswordResetRequestSchema,
  AuthPasswordResetResponseSchema,
  ContextResolveResponseSchema
} from '@ageniza/contracts';
import { Button, FieldMessage, TextInput } from '@ageniza/ui';
import { useQueryClient } from '@tanstack/react-query';

import { useAuthSessionStore } from './auth.js';
import { useDocumentTitle } from './document-title.js';
import { validateForm } from './forms.js';
import { HttpClientError, useApiClient } from './http.js';

const RESET_FAILED = 'Não foi possível salvar a nova senha. Tente de novo.';
const RESOLVE_FAILED = 'Sua senha foi alterada, mas não foi possível carregar seus contextos. Tente de novo.';
const SIGN_IN_NOTICE = 'Senha redefinida. Entre com a nova senha.';

/**
 * `/senha/redefinir?token=…&invite=…`. The token comes from the URL; the optional `invite` continues
 * an invitation after the reset. A reset always answers 200 (issue #175): `signedIn: true` means a
 * session exists, `NO_CONTEXT_ACCESS` means the account has no context at all, and
 * `SIGN_IN_REQUIRED` means the password changed but the server could not create a session. A used or
 * expired token is the one 400 `INVALID_LINK`, shown as this screen's own invalid state.
 */
export function ResetPasswordPage() {
  const httpClient = useApiClient();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const authStore = useAuthSessionStore();
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') ?? '';
  const inviteToken = searchParams.get('invite') ?? undefined;
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [formError, setFormError] = useState<string | undefined>();
  const [resolveError, setResolveError] = useState<string | undefined>();
  const [invalid, setInvalid] = useState(token.length === 0);
  const [submitting, setSubmitting] = useState(false);
  const [resolving, setResolving] = useState(false);
  useDocumentTitle('Definir nova senha — Ageniza');

  // A missing token is a broken link; strip the token from the URL once the link is known bad.
  useEffect(() => {
    if (invalid && searchParams.toString() !== '') navigate('/senha/redefinir', { replace: true });
  }, [invalid, searchParams, navigate]);

  const leaveToNoAccess = (): void => {
    authStore.end();
    queryClient.clear();
    navigate('/sem-acesso', { replace: true });
  };

  /** After a successful reset the session exists; only the resolve is left, repeatable on its own. */
  const runResolve = async (): Promise<void> => {
    setResolveError(undefined);
    setResolving(true);
    try {
      const resolve = await httpClient.request({ path: '/me/contexts/resolve', response: ContextResolveResponseSchema });
      if (resolve.decision === 'none') { leaveToNoAccess(); return; }
      navigate(resolve.decision === 'select' ? '/contextos' : '/app', { replace: true });
    } catch {
      setResolveError(RESOLVE_FAILED);
    } finally {
      setResolving(false);
    }
  };

  const onSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setFormError(undefined);
    setResolveError(undefined);
    const validation = validateForm(AuthPasswordResetRequestSchema, {
      token,
      newPassword: password,
      ...(inviteToken === undefined ? {} : { inviteToken })
    });
    if (!validation.success) {
      // A missing token or an out-of-shape invite is a broken link, not a form error.
      if (validation.errors.token !== undefined || validation.errors.inviteToken !== undefined) { setInvalid(true); return; }
      setError(password.length > 128 ? 'A senha pode ter no máximo 128 caracteres.' : 'A senha tem no mínimo 10 caracteres.');
      return;
    }
    setError(undefined);
    setSubmitting(true);
    try {
      const result = await httpClient.request({
        path: '/auth/password/reset',
        method: 'POST',
        body: validation.data,
        response: AuthPasswordResetResponseSchema
      });
      if (!result.signedIn) {
        if (result.reason === 'NO_CONTEXT_ACCESS') { leaveToNoAccess(); return; }
        // SIGN_IN_REQUIRED: the password changed; keep the invitation continuation when there is one,
        // so the next login carries the token and does not land on no-access (rule 3a).
        navigate('/entrar', {
          replace: true,
          state: inviteToken === undefined
            ? { notice: SIGN_IN_NOTICE }
            : { notice: SIGN_IN_NOTICE, inviteToken, sessionDestination: { path: `/convite/${encodeURIComponent(inviteToken)}`, savedAt: Date.now() } }
        });
        return;
      }
      // A new session may belong to a different account; drop the previous account's cache first.
      queryClient.clear();
      await authStore.refresh();
      if (inviteToken !== undefined) { navigate(`/convite/${encodeURIComponent(inviteToken)}`, { replace: true }); return; }
      await runResolve();
    } catch (caught: unknown) {
      if (caught instanceof HttpClientError && caught.status === 400 && caught.code === 'INVALID_LINK') { setInvalid(true); return; }
      if (caught instanceof HttpClientError && caught.status === 429) { setFormError('Muitas tentativas. Tente novamente mais tarde.'); return; }
      setFormError(RESET_FAILED);
    } finally {
      setSubmitting(false);
    }
  };

  if (invalid) {
    return <section className="form-panel" aria-labelledby="reset-title">
      <h1 id="reset-title">Este link não é mais válido</h1>
      <p>Links de redefinição valem por 30 minutos e só podem ser usados uma vez.</p>
      <Link to="/senha/esquecida">Pedir um novo link</Link>
    </section>;
  }

  return <section className="form-panel" aria-labelledby="reset-title">
    <h1 id="reset-title">Definir nova senha</h1>
    <form className="form-stack" onSubmit={onSubmit} noValidate>
      <div className="form-field">
        <label htmlFor="reset-password">Nova senha</label>
        <TextInput
          id="reset-password"
          name="newPassword"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          aria-invalid={error !== undefined}
          aria-describedby={error === undefined ? 'reset-password-help' : 'reset-password-help reset-password-error'}
        />
        <p id="reset-password-help" className="form-hint">Mínimo de 10 caracteres</p>
        {error !== undefined && <FieldMessage id="reset-password-error">{error}</FieldMessage>}
      </div>
      {resolveError !== undefined && <div role="alert">
        <p>{resolveError}</p>
        <Button onClick={() => { void runResolve(); }} loading={resolving}>Tentar de novo</Button>
      </div>}
      {formError !== undefined && <p role="alert">{formError}</p>}
      <div className="form-actions">
        <Button type="submit" loading={submitting}>Salvar</Button>
      </div>
    </form>
  </section>;
}
