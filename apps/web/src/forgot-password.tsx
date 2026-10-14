import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { AuthPasswordForgotRequestSchema, AuthPasswordForgotResponseSchema } from '@ageniza/contracts';
import { ArrowLeft } from 'lucide-react';
import { Button, Field, TextInput } from '@ageniza/ui';

import { AuthMessage, AuthPanel } from './auth-layout.js';
import { useDocumentTitle } from './document-title.js';
import { validateForm } from './forms.js';
import { HttpClientError, useApiClient } from './http.js';

/**
 * `POST /auth/password/forgot` answers identically whether or not the address has an account
 * (specs/auth.md section 5), so the confirmation never confirms or denies an account. The screen
 * switches state in place instead of navigating, and only a rate limit gets its own message.
 *
 * The optional `inviteToken` arrives through router state (never the URL), so a person who lost the
 * password in the middle of an existing account's invitation continues that invitation after the
 * reset (decisions.md, "O reset continua o convite automaticamente").
 */
export function ForgotPasswordPage() {
  const httpClient = useApiClient();
  const location = useLocation();
  const confirmationRef = useRef<HTMLHeadingElement>(null);
  const [email, setEmail] = useState('');
  const [emailError, setEmailError] = useState<string | undefined>();
  const [formError, setFormError] = useState<string | undefined>();
  const [sent, setSent] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useDocumentTitle('Recuperar acesso — Ageniza');

  // The form is replaced by the confirmation, so the button that had focus disappears; move focus
  // to the confirmation heading so a screen reader announces the new state.
  useEffect(() => {
    if (sent) confirmationRef.current?.focus();
  }, [sent]);

  const state = location.state as { inviteToken?: unknown } | null;
  const inviteToken = typeof state?.inviteToken === 'string' ? state.inviteToken : undefined;

  const onSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setFormError(undefined);
    const validation = validateForm(AuthPasswordForgotRequestSchema, {
      email,
      ...(inviteToken === undefined ? {} : { inviteToken })
    });
    if (!validation.success) {
      setEmailError('Informe um e-mail válido.');
      return;
    }
    setEmailError(undefined);
    setSubmitting(true);
    try {
      await httpClient.request({
        path: '/auth/password/forgot',
        method: 'POST',
        body: validation.data,
        response: AuthPasswordForgotResponseSchema
      });
      setSent(true);
    } catch (error: unknown) {
      setFormError(error instanceof HttpClientError && error.status === 429
        ? 'Muitas tentativas. Tente novamente mais tarde.'
        : 'Não foi possível enviar o link. Tente de novo.');
    } finally {
      setSubmitting(false);
    }
  };

  const backToSignIn = <Link className="auth-back" to="/entrar"><ArrowLeft className="auth-back__icon" aria-hidden="true" />Voltar para entrar</Link>;

  if (sent) {
    return <AuthPanel
      titleId="forgot-title"
      title="Verifique seu e-mail"
      lead="Se existir uma conta com esse endereço, o link chegou. Ele vale por 30 minutos."
      headingRef={confirmationRef}
    >
      {backToSignIn}
    </AuthPanel>;
  }

  return <AuthPanel
    titleId="forgot-title"
    title="Recuperar acesso"
    lead="Informe o e-mail da sua conta e enviaremos um link para definir uma nova senha."
  >
    <form className="auth-form" onSubmit={onSubmit} noValidate>
      <Field label="E-mail" id="forgot-email" error={emailError}>
        {(control) => <TextInput
          {...control}
          name="email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />}
      </Field>
      {formError !== undefined && <AuthMessage tone="danger" role="alert">{formError}</AuthMessage>}
      <Button type="submit" className="auth-submit" loading={submitting}>Enviar link</Button>
      {backToSignIn}
    </form>
  </AuthPanel>;
}
