import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { AuthSignUpRequestSchema, AuthSignUpResponseSchema } from '@ageniza/contracts';
import { ArrowLeft } from 'lucide-react';
import { Button, Field, TextInput, useFormErrors } from '@ageniza/ui';

import { AuthMessage, AuthPanel } from './auth-layout.js';
import { useDocumentTitle } from './document-title.js';
import { ResendVerification } from './email-verification.js';
import { validateForm } from './forms.js';
import { HttpClientError, useApiClient } from './http.js';

/** The address the approval link was sent to, carried by the navigation and never by the URL: the field starts with it, and the person can change it. */
export const signUpEmailState = (email: string): { email: string } => ({ email });

const prefilledEmail = (state: unknown): string => {
  const carried = typeof state === 'object' && state !== null ? (state as { email?: unknown }).email : undefined;
  const parsed = AuthSignUpRequestSchema.shape.email.safeParse(carried);
  return parsed.success ? parsed.data : '';
};

/**
 * `/criar-conta` (specs/auth.md section 13). `POST /auth/sign-up` answers the same whether or not the
 * address already has an account, so after sending the screen is always the same: the link went to
 * the e-mail, with a resend. "Entrar com o Google" has its place here and lands with its own issue.
 */
export function SignUpPage() {
  const httpClient = useApiClient();
  const { formRef, summary } = useFormErrors();
  const sentRef = useRef<HTMLHeadingElement>(null);
  const location = useLocation();
  const [name, setName] = useState('');
  const [email, setEmail] = useState(() => prefilledEmail(location.state));
  const [password, setPassword] = useState('');
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [errors, setErrors] = useState<{ name?: string; email?: string; password?: string }>({});
  const [formError, setFormError] = useState<string | undefined>();
  const [sentTo, setSentTo] = useState<string | undefined>();
  const [submitting, setSubmitting] = useState(false);
  useDocumentTitle('Criar conta — Ageniza');

  useEffect(() => {
    if (sentTo !== undefined) sentRef.current?.focus();
  }, [sentTo]);

  const onSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setFormError(undefined);
    const validation = validateForm(AuthSignUpRequestSchema, { name, email, password, acceptTerms: acceptedTerms });
    if (!validation.success) {
      setErrors({
        name: validation.errors.name === undefined ? undefined : 'Informe o seu nome.',
        email: validation.errors.email === undefined ? undefined : 'Informe um e-mail válido.',
        password: validation.errors.password === undefined ? undefined : (password.length > 128 ? 'A senha pode ter no máximo 128 caracteres.' : 'A senha tem no mínimo 10 caracteres.')
      });
      return;
    }
    setErrors({});
    setSubmitting(true);
    try {
      await httpClient.request({ path: '/auth/sign-up', method: 'POST', body: validation.data, response: AuthSignUpResponseSchema });
      setSentTo(validation.data.email);
    } catch (caught: unknown) {
      setFormError(caught instanceof HttpClientError && caught.status === 429
        ? 'Muitas tentativas. Tente novamente mais tarde.'
        : 'Não foi possível criar a conta. Tente de novo.');
    } finally {
      setSubmitting(false);
    }
  };

  const backToSignIn = <Link className="auth-back" to="/entrar"><ArrowLeft className="auth-back__icon" aria-hidden="true" />Já tenho conta</Link>;

  if (sentTo !== undefined) {
    return <AuthPanel
      titleId="sign-up-title"
      title="Enviamos um link para o seu e-mail"
      lead={`Abra o link enviado para ${sentTo} e confirme com a sua senha. Ele vale por 24 horas.`}
      headingRef={sentRef}
    >
      <ResendVerification email={sentTo} idPrefix="sign-up" />
      {backToSignIn}
    </AuthPanel>;
  }

  return <AuthPanel titleId="sign-up-title" title="Criar conta" lead="Crie a sua conta e comece a montar a pauta da sua agência.">
    <form ref={formRef} className="auth-form" onSubmit={onSubmit} noValidate>
      {summary}
      <Field label="Nome" id="sign-up-name" error={errors.name}>
        {(control) => <TextInput {...control} name="name" autoComplete="name" value={name} onChange={(event) => setName(event.target.value)} />}
      </Field>
      <Field label="E-mail" id="sign-up-email" error={errors.email}>
        {(control) => <TextInput {...control} name="email" type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} />}
      </Field>
      <Field label="Senha" id="sign-up-password" hint="Mínimo de 10 caracteres" error={errors.password}>
        {(control) => <TextInput {...control} name="password" type="password" autoComplete="new-password" value={password}
          onChange={(event) => setPassword(event.target.value)} />}
      </Field>
      <label className="auth-check">
        <input type="checkbox" checked={acceptedTerms} onChange={(event) => setAcceptedTerms(event.target.checked)} />
        <span>
          Li e aceito os <Link to="/termos" target="_blank" rel="noreferrer">Termos de Uso</Link> e a{' '}
          <Link to="/privacidade" target="_blank" rel="noreferrer">Política de Privacidade</Link>
        </span>
      </label>
      {formError !== undefined && <AuthMessage tone="danger" role="alert">{formError}</AuthMessage>}
      <Button type="submit" className="auth-submit" loading={submitting} disabled={!acceptedTerms}>Criar conta</Button>
      {backToSignIn}
    </form>
  </AuthPanel>;
}
