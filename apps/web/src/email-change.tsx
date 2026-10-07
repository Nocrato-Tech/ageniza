import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';

import {
  EmailChangeConfirmResponseSchema,
  EmailChangeRequestResponseSchema,
  EmailChangeRequestSchema
} from '@ageniza/contracts';
import { Button, FieldMessage, Modal, TextInput } from '@ageniza/ui';

import { useOptionalAuthSessionStore } from './auth.js';
import { useDocumentTitle } from './document-title.js';
import { validateForm } from './forms.js';
import { HttpClientError, useApiClient } from './http.js';

const REQUEST_FAILED = 'Não foi possível enviar o pedido. Tente de novo.';
const RATE_LIMITED = 'Muitas tentativas. Tente novamente mais tarde.';
const CONFIRM_FAILED = 'Não foi possível confirmar a troca. Tente de novo.';

/**
 * The account menu's "Pedir troca de e-mail" (issue #80). The person asks, with the current
 * password; the operation approves outside the product, and the link goes to the new address. The
 * success text says nothing about the new address, because the answer is the same whether or not
 * another account already uses it.
 */
export function EmailChangeDialog({ onClose }: { onClose: () => void }) {
  const httpClient = useApiClient();
  const [newEmail, setNewEmail] = useState('');
  const [password, setPassword] = useState('');
  const [emailError, setEmailError] = useState<string | undefined>();
  const [passwordError, setPasswordError] = useState<string | undefined>();
  const [formError, setFormError] = useState<string | undefined>();
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);

  const onSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setFormError(undefined);
    const validation = validateForm(EmailChangeRequestSchema, { newEmail, currentPassword: password });
    setEmailError(validation.success || validation.errors.newEmail === undefined ? undefined : 'Informe um e-mail válido.');
    setPasswordError(validation.success || validation.errors.currentPassword === undefined ? undefined : 'Informe a senha atual.');
    if (!validation.success) return;
    setSubmitting(true);
    try {
      await httpClient.request({
        path: '/me/email-change',
        method: 'POST',
        body: validation.data,
        response: EmailChangeRequestResponseSchema
      });
      setPassword('');
      setSent(true);
    } catch (caught: unknown) {
      if (caught instanceof HttpClientError && caught.status === 403 && caught.code === 'INVALID_PASSWORD') { setPasswordError('A senha atual não confere.'); return; }
      if (caught instanceof HttpClientError && caught.status === 400 && caught.code === 'SAME_EMAIL') { setEmailError('Informe um e-mail diferente do atual.'); return; }
      if (caught instanceof HttpClientError && caught.status === 429) { setFormError(RATE_LIMITED); return; }
      setFormError(REQUEST_FAILED);
    } finally {
      setSubmitting(false);
    }
  };

  return <Modal title='Pedir troca de e-mail' closeLabel='Fechar janela' onClose={onClose}>
    {sent
      ? <div className='form-stack'>
          <p role='status'>Pedido enviado. Avisamos o e-mail atual da conta. A operação analisa o pedido e, se aprovar, enviamos um link de confirmação para o novo endereço.</p>
          <p>Até lá nada muda: você continua entrando com o e-mail atual.</p>
          <div className='form-actions'><Button onClick={onClose}>Fechar</Button></div>
        </div>
      : <form className='form-stack' onSubmit={onSubmit} noValidate>
          <div className='form-field'>
            <label htmlFor='email-change-new'>Novo e-mail</label>
            <TextInput
              id='email-change-new'
              name='newEmail'
              type='email'
              autoComplete='email'
              value={newEmail}
              onChange={(event) => setNewEmail(event.target.value)}
              aria-invalid={emailError !== undefined}
              aria-describedby={emailError === undefined ? undefined : 'email-change-new-error'}
            />
            {emailError !== undefined && <FieldMessage id='email-change-new-error'>{emailError}</FieldMessage>}
          </div>
          <div className='form-field'>
            <label htmlFor='email-change-password'>Senha atual</label>
            <TextInput
              id='email-change-password'
              name='currentPassword'
              type='password'
              autoComplete='current-password'
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              aria-invalid={passwordError !== undefined}
              aria-describedby={passwordError === undefined ? undefined : 'email-change-password-error'}
            />
            {passwordError !== undefined && <FieldMessage id='email-change-password-error'>{passwordError}</FieldMessage>}
          </div>
          {formError !== undefined && <p role='alert'>{formError}</p>}
          <div className='form-actions'>
            <Button variant='ghost' onClick={onClose}>Cancelar</Button>
            <Button type='submit' loading={submitting}>Enviar pedido</Button>
          </div>
        </form>}
  </Modal>;
}

/**
 * `/email/confirmar?token=…`, the link the operation's approval sends to the new address. It asks
 * for a click instead of confirming on load: a mail scanner that opens the link must not spend it.
 * On success every session of the account is already gone, so the local session state is dropped too.
 */
export function ConfirmEmailChangePage() {
  const httpClient = useApiClient();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const authStore = useOptionalAuthSessionStore();
  const [searchParams] = useSearchParams();
  const [token] = useState(() => searchParams.get('token') ?? '');
  const [state, setState] = useState<'ready' | 'done' | 'invalid'>(token.length === 0 ? 'invalid' : 'ready');
  const [error, setError] = useState<string | undefined>();
  const [submitting, setSubmitting] = useState(false);
  useDocumentTitle('Confirmar novo e-mail — Ageniza');

  // The token leaves the address bar as soon as it is held in memory, spent or not.
  useEffect(() => {
    if (searchParams.toString() !== '') navigate('/email/confirmar', { replace: true });
  }, [searchParams, navigate]);

  const confirm = async (): Promise<void> => {
    setError(undefined);
    setSubmitting(true);
    try {
      await httpClient.request({
        path: '/email-change/confirm',
        method: 'POST',
        body: { token },
        response: EmailChangeConfirmResponseSchema
      });
      queryClient.clear();
      authStore?.end();
      setState('done');
    } catch (caught: unknown) {
      if (caught instanceof HttpClientError && caught.status === 400 && caught.code === 'INVALID_LINK') { setState('invalid'); return; }
      setError(caught instanceof HttpClientError && caught.status === 429 ? RATE_LIMITED : CONFIRM_FAILED);
    } finally {
      setSubmitting(false);
    }
  };

  if (state === 'invalid') {
    return <section className='form-panel' aria-labelledby='email-change-title'>
      <h1 id='email-change-title'>Este link não é mais válido</h1>
      <p>Links de confirmação valem por 48 horas e só podem ser usados uma vez. Se ainda quiser trocar o e-mail, peça de novo pelo menu da conta.</p>
      <Link to='/entrar'>Entrar</Link>
    </section>;
  }

  if (state === 'done') {
    return <section className='form-panel' aria-labelledby='email-change-title'>
      <h1 id='email-change-title'>E-mail alterado</h1>
      <p role='status'>O novo e-mail já vale para a sua conta. Por segurança, todas as sessões foram encerradas.</p>
      <Link to='/entrar'>Entrar com o novo e-mail</Link>
    </section>;
  }

  return <section className='form-panel' aria-labelledby='email-change-title'>
    <h1 id='email-change-title'>Confirmar novo e-mail</h1>
    <p>Confirme para usar este endereço como o e-mail da sua conta no Ageniza. Todas as sessões abertas serão encerradas.</p>
    {error !== undefined && <p role='alert'>{error}</p>}
    <div className='form-actions'>
      <Button onClick={() => { void confirm(); }} loading={submitting}>Confirmar troca de e-mail</Button>
    </div>
  </section>;
}
