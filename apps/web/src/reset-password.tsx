import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  AuthInvitationTokenSchema,
  AuthPasswordResetRequestSchema,
  AuthPasswordResetResponseSchema
} from '@ageniza/contracts';
import { Button, Field, TextInput, useFormErrors } from '@ageniza/ui';
import { useQueryClient } from '@tanstack/react-query';

import { useAuthSessionStore } from './auth.js';
import { AUTH_LINK_BUTTON_CLASS, AuthMessage, AuthPanel } from './auth-layout.js';
import { useDocumentTitle } from './document-title.js';
import { validateForm } from './forms.js';
import { HttpClientError, useApiClient } from './http.js';

const RESET_FAILED = 'Não foi possível salvar a nova senha. Tente de novo.';
const SIGN_IN_NOTICE = 'Senha alterada. Entre com a nova senha.';

/**
 * `/senha/redefinir?token=…&invite=…`. The token comes from the URL. A reset changes the password and
 * creates no session (2026-10-16): success always goes to `/entrar` with a notice, and the optional
 * `invite` rides along in the navigation state so that login continues the invitation (rule 3a). A
 * used or expired token is the one 400 `INVALID_LINK`, shown as this screen's own invalid state.
 */
export function ResetPasswordPage() {
  const httpClient = useApiClient();
  const { formRef, summary } = useFormErrors();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const authStore = useAuthSessionStore();
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') ?? '';
  const inviteToken = searchParams.get('invite') ?? undefined;
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [formError, setFormError] = useState<string | undefined>();
  const [invalid, setInvalid] = useState(token.length === 0);
  const [submitting, setSubmitting] = useState(false);
  useDocumentTitle('Definir nova senha — Ageniza');

  // A missing token is a broken link; strip the token from the URL once the link is known bad.
  useEffect(() => {
    if (invalid && searchParams.toString() !== '') navigate('/senha/redefinir', { replace: true });
  }, [invalid, searchParams, navigate]);

  const onSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setFormError(undefined);
    const validation = validateForm(AuthPasswordResetRequestSchema, { token, newPassword: password });
    // A missing token or an out-of-shape invite is a broken link, not a form error; the invite is
    // not part of the request, but the login that follows would refuse it.
    if (inviteToken !== undefined && !AuthInvitationTokenSchema.safeParse(inviteToken).success) { setInvalid(true); return; }
    if (!validation.success) {
      if (validation.errors.token !== undefined) { setInvalid(true); return; }
      setError(password.length > 128 ? 'A senha pode ter no máximo 128 caracteres.' : 'A senha tem no mínimo 10 caracteres.');
      return;
    }
    setError(undefined);
    setSubmitting(true);
    try {
      await httpClient.request({
        path: '/auth/password/reset',
        method: 'POST',
        body: validation.data,
        response: AuthPasswordResetResponseSchema
      });
      // The reset ended every session of the account; drop what this browser still holds of one, so
      // the login screen does not mistake it for a valid session and skip the notice.
      authStore.end();
      queryClient.clear();
      navigate('/entrar', {
        replace: true,
        state: inviteToken === undefined
          ? { notice: SIGN_IN_NOTICE }
          : { notice: SIGN_IN_NOTICE, inviteToken, sessionDestination: { path: `/convite/${encodeURIComponent(inviteToken)}`, savedAt: Date.now() } }
      });
    } catch (caught: unknown) {
      if (caught instanceof HttpClientError && caught.status === 400 && caught.code === 'INVALID_LINK') { setInvalid(true); return; }
      if (caught instanceof HttpClientError && caught.status === 429) { setFormError('Muitas tentativas. Tente novamente mais tarde.'); return; }
      setFormError(RESET_FAILED);
    } finally {
      setSubmitting(false);
    }
  };

  if (invalid) {
    return <AuthPanel
      titleId="reset-title"
      title="Este link não é mais válido"
      lead="Links de redefinição valem por 30 minutos e só podem ser usados uma vez."
    >
      <Link className={AUTH_LINK_BUTTON_CLASS} to="/senha/esquecida">Pedir um novo link</Link>
    </AuthPanel>;
  }

  return <AuthPanel titleId="reset-title" title="Definir nova senha">
    <form ref={formRef} className="auth-form" onSubmit={onSubmit} noValidate>
      {summary}
      <Field label="Nova senha" id="reset-password" hint="Mínimo de 10 caracteres" error={error}>
        {(control) => <TextInput
          {...control}
          name="newPassword"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />}
      </Field>
      {formError !== undefined && <AuthMessage tone="danger" role="alert">{formError}</AuthMessage>}
      <Button type="submit" className="auth-submit" loading={submitting}>Salvar</Button>
    </form>
  </AuthPanel>;
}
