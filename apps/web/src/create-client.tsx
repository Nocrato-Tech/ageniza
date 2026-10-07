import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { z } from 'zod';

import { ClientNameSchema, ClientSchema } from '@ageniza/contracts';
import { Button, FieldMessage, Modal, TextInput } from '@ageniza/ui';

import { useAgencyContext } from './agency.js';
import { apiPath } from './api-path.js';
import { HttpClientError, useApiClient } from './http.js';

const NAME_REQUIRED = 'Informe o nome do cliente.';
const NAME_INVALID = 'O nome contém caracteres que não são aceitos.';
const NAME_IN_USE = 'Já existe um cliente ativo com este nome.';
const VALIDATION_FAILED = 'Revise os dados informados.';
const NO_PERMISSION = 'Você não tem permissão para cadastrar clientes.';
const CREATE_FAILED = 'Não foi possível cadastrar o cliente. Tente de novo.';
const NAME_HINT = 'Os demais dados você completa depois.';

/** Validation issues carry the field path the API refused; only that field is marked. */
const refusedName = (details: unknown): boolean => {
  const parsed = z.object({ issues: z.array(z.object({ path: z.string() })) }).safeParse(details);
  return parsed.success && parsed.data.issues.some((issue) => issue.path === 'name' || issue.path.startsWith('name.'));
};

/**
 * The create modal (`specs/clientes.md` §7): the name, and nothing else — it is the only required
 * field, and the registration starts on a phone call. A `201` invalidates the roster and opens the
 * new client's detail; a `409` marks the field and keeps what was typed.
 */
export function CreateClientDialog({ onClose }: { onClose: () => void }) {
  const agency = useAgencyContext();
  const httpClient = useApiClient();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const nameId = useId();
  const hintId = useId();
  const errorId = useId();
  const [name, setName] = useState('');
  const [nameError, setNameError] = useState<string | undefined>();
  const [formError, setFormError] = useState<string | undefined>();
  const nameRef = useRef<HTMLInputElement>(null);

  // `autoFocus` would run before `Modal` captures the previous focus and break the focus return.
  useEffect(() => { nameRef.current?.focus(); }, []);

  const applyError = (error: unknown): void => {
    if (!(error instanceof HttpClientError)) { setFormError(CREATE_FAILED); return; }
    if (error.code === 'CLIENT_NAME_IN_USE' || error.status === 409) { setNameError(NAME_IN_USE); return; }
    if (error.code === 'FORBIDDEN' || error.status === 403) { setFormError(NO_PERMISSION); return; }
    if (error.status === 400) {
      if (refusedName(error.details)) setNameError(NAME_INVALID);
      else setFormError(VALIDATION_FAILED);
      return;
    }
    setFormError(CREATE_FAILED);
  };

  const create = useMutation({
    mutationFn: (clientName: string) => httpClient.request({
      path: apiPath('/agencies/:agenciaId/clients', { agenciaId: agency.agencyId }),
      method: 'POST',
      body: { name: clientName },
      response: ClientSchema
    }),
    onSuccess: (client) => {
      void queryClient.invalidateQueries({ queryKey: ['agency', agency.agencyId, 'clients'] });
      onClose();
      navigate(`/agencia/${agency.agencyId}/clientes/${client.id}/geral`);
    },
    onError: (error: unknown) => { applyError(error); }
  });

  const canSubmit = name.trim() !== '';

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const value = name.trim();
    if (value === '') { setNameError(NAME_REQUIRED); return; }
    if (!ClientNameSchema.safeParse(value).success) { setNameError(NAME_INVALID); return; }
    create.mutate(value);
  };

  return <Modal title="Cadastrar cliente" closeLabel="Fechar cadastro de cliente" onClose={onClose}>
    <form className="form-stack" onSubmit={onSubmit} noValidate>
      <div className="form-field">
        <label htmlFor={nameId}>Nome</label>
        <TextInput
          ref={nameRef}
          id={nameId}
          name="name"
          value={name}
          onChange={(event) => { setName(event.target.value); setNameError(undefined); setFormError(undefined); }}
          aria-invalid={nameError !== undefined}
          aria-describedby={nameError === undefined ? hintId : `${hintId} ${errorId}`}
        />
        <p id={hintId} className="form-hint">{NAME_HINT}</p>
        {nameError !== undefined && <FieldMessage id={errorId} role="alert">{nameError}</FieldMessage>}
      </div>

      {formError !== undefined && <FieldMessage role="alert">{formError}</FieldMessage>}

      <div className="form-actions">
        <Button type="submit" disabled={!canSubmit} loading={create.isPending}>Cadastrar</Button>
      </div>
    </form>
  </Modal>;
}
