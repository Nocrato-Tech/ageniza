import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  AuthEmailVerificationResendRequestSchema,
  AuthEmailVerificationResendResponseSchema,
  AuthEmailVerifyRequestSchema,
  AuthEmailVerifyResponseSchema
} from '@ageniza/contracts';
import { ArrowLeft } from 'lucide-react';
import { Button, Field, TextInput, useFormErrors } from '@ageniza/ui';
import { useQueryClient } from '@tanstack/react-query';

import { useOptionalAuthSessionStore } from './auth.js';
import { AuthMessage, AuthPanel } from './auth-layout.js';
import { useDocumentTitle } from './document-title.js';
import { validateForm } from './forms.js';
import { HttpClientError, useApiClient } from './http.js';

const RATE_LIMITED = 'Muitas tentativas. Tente novamente mais tarde.';
const RESENT = 'Se houver uma conta esperando confirmação com esse e-mail, enviamos um novo link. O anterior deixou de valer.';

/**
 * Asks for a new confirmation link. The answer is the same whether or not the address has an account
 * waiting, so the screen says the same either way.
 */
export function ResendVerification({ email, idPrefix, lead, buttonLabel = 'Reenviar o link' }: {
  email?: string;
  idPrefix: string;
  lead?: string;
  buttonLabel?: string;
}) {
  const httpClient = useApiClient();
  const [typed, setTyped] = useState(email ?? '');
  const [emailError, setEmailError] = useState<string | undefined>();
  const [status, setStatus] = useState<'idle' | 'sent'>('idle');
  const [error, setError] = useState<string | undefined>();
  const [sending, setSending] = useState(false);

  const resend = async (): Promise<void> => {
    setError(undefined);
    const validation = validateForm(AuthEmailVerificationResendRequestSchema, { email: email ?? typed });
    if (!validation.success) { setEmailError('Informe um e-mail válido.'); return; }
    setEmailError(undefined);
    setSending(true);
    try {
      await httpClient.request({ path: '/auth/email/verification/resend', method: 'POST', body: validation.data, response: AuthEmailVerificationResendResponseSchema });
      setStatus('sent');
    } catch (caught: unknown) {
      setError(caught instanceof HttpClientError && caught.status === 429 ? RATE_LIMITED : 'Não foi possível reenviar o link. Tente de novo.');
    } finally {
      setSending(false);
    }
  };

  return <div className="auth-form">
    {lead !== undefined && <p className="auth-note">{lead}</p>}
    {email === undefined && <Field label="E-mail da conta" id={`${idPrefix}-resend-email`} error={emailError}>
      {(control) => <TextInput {...control} name="email" type="email" autoComplete="email" value={typed} onChange={(event) => setTyped(event.target.value)} />}
    </Field>}
    {status === 'sent' && <AuthMessage tone="success" role="status">{RESENT}</AuthMessage>}
    {error !== undefined && <AuthMessage tone="danger" role="alert">{error}</AuthMessage>}
    <Button variant="secondary" className="auth-submit" onClick={() => { void resend(); }} loading={sending}>{buttonLabel}</Button>
  </div>;
}

/**
 * `/email/verificar?token=…`: the link alone confirms nothing (finding A1 of the review of PR #720).
 * It asks for the account's password and a click, so a mail reader opening the link spends nothing
 * and whoever did not create the account cannot confirm it. The token leaves the address bar as soon
 * as it is held. Success signs the confirmed account in, replacing any session the browser had, and
 * goes to `/contextos`, which sends the account with no context to `/comecar`.
 */
export function VerifyEmailPage() {
  const httpClient = useApiClient();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const authStore = useOptionalAuthSessionStore();
  const { formRef } = useFormErrors();
  const [searchParams] = useSearchParams();
  const [token] = useState(() => searchParams.get('token') ?? '');
  const [password, setPassword] = useState('');
  const [passwordError, setPasswordError] = useState<string | undefined>();
  const [formError, setFormError] = useState<string | undefined>();
  const [refused, setRefused] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  useDocumentTitle('Confirmar e-mail — Ageniza');

  useEffect(() => {
    if (searchParams.toString() !== '') navigate('/email/verificar', { replace: true });
  }, [searchParams, navigate]);

  const onSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setFormError(undefined);
    const validation = validateForm(AuthEmailVerifyRequestSchema, { token, password });
    if (!validation.success) { setPasswordError('Informe a sua senha.'); return; }
    setPasswordError(undefined);
    setSubmitting(true);
    try {
      await httpClient.request({ path: '/auth/email/verify', method: 'POST', body: validation.data, response: AuthEmailVerifyResponseSchema });
    } catch (caught: unknown) {
      setSubmitting(false);
      if (caught instanceof HttpClientError && caught.status === 400 && caught.code === 'INVALID_LINK_OR_PASSWORD') { setRefused(true); return; }
      setFormError(caught instanceof HttpClientError && caught.status === 429 ? RATE_LIMITED : 'Não foi possível confirmar o e-mail. Tente de novo.');
      return;
    }
    queryClient.clear();
    await authStore?.refresh();
    navigate('/contextos', { replace: true });
  };

  const backToSignIn = <Link className="auth-back" to="/entrar"><ArrowLeft className="auth-back__icon" aria-hidden="true" />Voltar para entrar</Link>;

  if (token.length === 0) {
    return <AuthPanel titleId="verify-title" title="Este link não é mais válido" lead="Links de confirmação valem por 24 horas e só podem ser usados uma vez. Peça um novo link abaixo.">
      <ResendVerification idPrefix="verify" />
      {backToSignIn}
    </AuthPanel>;
  }

  return <AuthPanel titleId="verify-title" title="Confirmar e-mail" lead="Para confirmar, digite a senha que você escolheu ao criar a conta.">
    <form ref={formRef} className="auth-form" onSubmit={onSubmit} noValidate>
      <Field label="Senha" id="verify-password" error={passwordError}>
        {(control) => <TextInput {...control} name="password" type="password" autoComplete="current-password" value={password}
          onChange={(event) => setPassword(event.target.value)} />}
      </Field>
      {refused && <AuthMessage tone="danger" role="alert">
        O link não é mais válido ou a senha está incorreta. Links valem por 24 horas e só podem ser usados uma vez.
        Se você não criou esta conta, use <Link to="/senha/esquecida">Esqueci minha senha</Link> para ficar com este endereço.
      </AuthMessage>}
      {formError !== undefined && <AuthMessage tone="danger" role="alert">{formError}</AuthMessage>}
      <Button type="submit" className="auth-submit" loading={submitting}>Confirmar e-mail</Button>
    </form>
    {refused && <ResendVerification idPrefix="verify" />}
    {backToSignIn}
  </AuthPanel>;
}
