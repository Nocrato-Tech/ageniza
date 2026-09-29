import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { AuthPasswordForgotRequestSchema, AuthPasswordForgotResponseSchema } from '@ageniza/contracts';
import { Button, FieldMessage, TextInput } from '@ageniza/ui';

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

  if (sent) {
    return <section className="form-panel" aria-labelledby="forgot-title">
      <h1 id="forgot-title" ref={confirmationRef} tabIndex={-1}>Verifique seu e-mail</h1>
      <p>Se existir uma conta com esse endereço, o link chegou. Ele vale por 30 minutos.</p>
      <Link to="/entrar">Voltar para entrar</Link>
    </section>;
  }

  return <section className="form-panel" aria-labelledby="forgot-title">
    <h1 id="forgot-title">Recuperar acesso</h1>
    <p>Informe o e-mail da sua conta e enviaremos um link para definir uma nova senha.</p>
    <form className="form-stack" onSubmit={onSubmit} noValidate>
      <div className="form-field">
        <label htmlFor="forgot-email">E-mail</label>
        <TextInput
          id="forgot-email"
          name="email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          aria-invalid={emailError !== undefined}
          aria-describedby={emailError === undefined ? undefined : 'forgot-email-error'}
        />
        {emailError !== undefined && <FieldMessage id="forgot-email-error">{emailError}</FieldMessage>}
      </div>
      {formError !== undefined && <p role="alert">{formError}</p>}
      <div className="form-actions">
        <Button type="submit" loading={submitting}>Enviar link</Button>
        <Link to="/entrar">Voltar para entrar</Link>
      </div>
    </form>
  </section>;
}
