import { useId, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { AgencyRolesResponseSchema, CollaboratorSchema } from '@ageniza/contracts';
import { Button, FieldMessage, Modal, Select } from '@ageniza/ui';

import { useAgencyContext } from './agency.js';
import { apiPath } from './api-path.js';
import { HttpClientError, useApiClient } from './http.js';

const ROLE_REQUIRED = 'Selecione um papel.';
const ROLE_INVALID = 'Escolha um papel da lista.';
const NO_PERMISSION = 'Você não tem permissão para reativar com esse papel.';
const NOT_REMOVED = 'Este vínculo já está ativo. A lista foi atualizada.';
const REACTIVATE_FAILED = 'Não foi possível reativar. Tente de novo.';
const ROLES_FAILED = 'Não foi possível carregar os papéis. Tente de novo.';
const INTRO = 'Escolha o papel de acesso com que essa pessoa volta.';
const ROLE_HINT = 'O papel anterior não é reaproveitado.';

/**
 * Reactivation modal (specs/colaboradores.md §7, issue #105): the role starts empty and the button
 * stays disabled until one is chosen — the old role is never reused, because whoever comes back may
 * come back in another function. `Admin` is only offered to the Owner: the API hides it too, and the
 * database refuses it for anyone else, so hiding it here is convenience, not the barrier.
 */
export function ReactivateCollaboratorDialog({ membershipId, name, onClose }: {
  membershipId: string;
  name: string;
  onClose: () => void;
}) {
  const agency = useAgencyContext();
  const httpClient = useApiClient();
  const queryClient = useQueryClient();
  const roleHintId = useId();
  const roleErrorId = useId();
  const [roleId, setRoleId] = useState('');
  const [roleError, setRoleError] = useState<string | undefined>();
  const [formError, setFormError] = useState<string | undefined>();

  const roles = useQuery({
    queryKey: ['agency', agency.agencyId, 'roles'],
    queryFn: ({ signal }) => httpClient.request({
      path: apiPath('/agencies/:agenciaId/roles', { agenciaId: agency.agencyId }),
      response: AgencyRolesResponseSchema,
      signal
    })
  });

  // The server already omits `admin` for a caller who is not the Owner; the extra filter keeps the
  // promise of specs/colaboradores.md §7 even if that response ever regresses.
  const roleOptions = (roles.data?.data ?? [])
    .filter((role) => agency.isOwner || role.key !== 'admin')
    .map((role) => ({ value: role.id, label: role.name }));

  const reactivate = useMutation({
    mutationFn: (targetRoleId: string) => httpClient.request({
      path: apiPath('/agencies/:agenciaId/collaborators/:membershipId/reactivate', { agenciaId: agency.agencyId, membershipId }),
      method: 'POST',
      body: { roleId: targetRoleId },
      response: CollaboratorSchema
    }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['agency', agency.agencyId, 'collaborators'] });
      onClose();
    },
    onError: (error: unknown) => {
      if (error instanceof HttpClientError && error.status === 409) { setFormError(NOT_REMOVED); return; }
      if (error instanceof HttpClientError && error.code === 'INVALID_ROLE') { setRoleError(ROLE_INVALID); return; }
      if (error instanceof HttpClientError && (error.status === 403 || error.status === 404)) { setFormError(NO_PERMISSION); return; }
      setFormError(REACTIVATE_FAILED);
    },
    // A 409 means the list behind the dialog is stale; refetch it either way, so the badge reflects
    // what the server actually holds.
    onSettled: () => { void queryClient.invalidateQueries({ queryKey: ['agency', agency.agencyId, 'collaborators'] }); }
  });

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setFormError(undefined);
    if (roleId === '') { setRoleError(ROLE_REQUIRED); return; }
    reactivate.mutate(roleId);
  };

  return <Modal title={`Reativar ${name}`} closeLabel="Fechar reativação" onClose={onClose}>
    <form className="form-stack" onSubmit={onSubmit} noValidate>
      <p>{INTRO}</p>

      <div className="form-field">
        <Select
          label="Papel"
          value={roleId}
          placeholder="Selecione"
          options={roleOptions}
          disabled={roles.isPending || roles.isError}
          onChange={(value) => { setRoleId(value); setRoleError(undefined); setFormError(undefined); }}
          aria-invalid={roleError !== undefined}
          aria-describedby={roleError === undefined ? roleHintId : `${roleHintId} ${roleErrorId}`}
        />
        <p id={roleHintId} className="form-hint">{ROLE_HINT}</p>
        {roleError !== undefined && <FieldMessage id={roleErrorId} role="alert">{roleError}</FieldMessage>}
        {roles.isError && <div className="form-field">
          <FieldMessage role="alert">{ROLES_FAILED}</FieldMessage>
          <Button variant="secondary" size="sm" onClick={() => { void roles.refetch(); }} loading={roles.isFetching}>Tentar de novo</Button>
        </div>}
      </div>

      {formError !== undefined && <FieldMessage role="alert">{formError}</FieldMessage>}

      <div className="form-actions">
        <Button type="submit" disabled={roleId === ''} loading={reactivate.isPending}>Reativar</Button>
        <Button variant="ghost" onClick={onClose}>Cancelar</Button>
      </div>
    </form>
  </Modal>;
}
