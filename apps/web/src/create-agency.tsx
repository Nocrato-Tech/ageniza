import { useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';

import { CreateAgencyRequestSchema, CreateAgencyResponseSchema } from '@ageniza/contracts';
import { Button, Field, FieldMessage, Modal, TextInput, useFormErrors } from '@ageniza/ui';

import { contextDestination, contextTarget, rememberContext } from './context-destination.js';
import { validateForm } from './forms.js';
import { HttpClientError, useApiClient } from './http.js';

export const CREATE_AGENCY_LABEL = 'Criar agência';

const NAME_INVALID = 'Informe o nome da agência, com até 256 caracteres e sem caracteres invisíveis.';
const NOT_VERIFIED = 'Confirme o seu e-mail antes de criar uma agência.';
const ALREADY_IN_TRIAL = 'Sua conta já tem uma agência em período de teste.';
const CREATE_FAILED = 'Não foi possível criar a agência. Tente de novo.';

/**
 * "Criar agência" (issue #714): only the name. The agency is born in a 14-day trial with the person as Owner, and the
 * screen enters it right away, as choosing a context does. The database decides who may create one.
 */
export function CreateAgencyDialog({ onClose }: { onClose: () => void }) {
  const httpClient = useApiClient();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { formRef, summary } = useFormErrors();
  const [name, setName] = useState('');
  const [nameError, setNameError] = useState<string | undefined>();
  const [formError, setFormError] = useState<string | undefined>();
  const [submitting, setSubmitting] = useState(false);

  const onSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setFormError(undefined);
    const validation = validateForm(CreateAgencyRequestSchema, { name });
    setNameError(validation.success ? undefined : NAME_INVALID);
    if (!validation.success) return;
    setSubmitting(true);
    try {
      const { context } = await httpClient.request({
        path: '/agencies',
        method: 'POST',
        body: validation.data,
        response: CreateAgencyResponseSchema
      });
      await rememberContext(httpClient, contextTarget(context));
      queryClient.clear();
      navigate(contextDestination(context), { replace: true });
    } catch (caught: unknown) {
      if (caught instanceof HttpClientError && caught.code === 'EMAIL_NOT_VERIFIED') { setFormError(NOT_VERIFIED); return; }
      if (caught instanceof HttpClientError && caught.code === 'TRIAL_ALREADY_EXISTS') { setFormError(ALREADY_IN_TRIAL); return; }
      if (caught instanceof HttpClientError && caught.status === 400) { setNameError(NAME_INVALID); return; }
      setFormError(CREATE_FAILED);
    } finally {
      setSubmitting(false);
    }
  };

  return <Modal title={CREATE_AGENCY_LABEL} closeLabel='Fechar janela' onClose={onClose}>
    <form ref={formRef} className='form-stack' onSubmit={onSubmit} noValidate>
      {summary}
      <p>A agência começa com 14 dias de teste, com até 3 clientes ativos, 3 colaboradores (contando você) e 2 GB de mídia. Você será a dona ou o dono da agência.</p>
      <Field label='Nome da agência' id='create-agency-name' error={nameError}>
        {(control) => <TextInput
          {...control}
          name='name'
          autoComplete='organization'
          value={name}
          onChange={(event) => { setName(event.target.value); }}
        />}
      </Field>
      {formError !== undefined && <FieldMessage role='alert'>{formError}</FieldMessage>}
      <div className='form-actions'>
        <Button variant='ghost' onClick={onClose}>Cancelar</Button>
        <Button type='submit' loading={submitting}>{CREATE_AGENCY_LABEL}</Button>
      </div>
    </form>
  </Modal>;
}
