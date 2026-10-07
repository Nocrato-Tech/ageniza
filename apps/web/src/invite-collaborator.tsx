import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';

import {
  AgencyRolesResponseSchema,
  AuthEmailSchema,
  CollaboratorInvitationCreatedResponseSchema
} from '@ageniza/contracts';
import { Button, FieldMessage, LiveStatus, Modal, Select, TextInput } from '@ageniza/ui';

import { useAgencyContext } from './agency.js';
import { apiPath } from './api-path.js';
import { HttpClientError, useApiClient } from './http.js';

const EMAIL_REQUIRED = 'Informe o e-mail.';
const EMAIL_INVALID = 'Informe um e-mail válido.';
const EMAIL_ALREADY_MEMBER = 'Esta pessoa já faz parte da equipe.';
const ROLE_REQUIRED = 'Selecione um papel.';
const ROLE_INVALID = 'Escolha um papel da lista.';
const VALIDATION_FAILED = 'Revise os dados do convite.';
const NO_PERMISSION = 'Você não tem permissão para convidar para esta agência.';
const SEND_FAILED = 'Não foi possível enviar o convite. Tente de novo.';
const ROLES_FAILED = 'Não foi possível carregar os papéis. Tente de novo.';
const ROLE_HINT = 'Define o que a pessoa poderá fazer.';
const SUPERSEDED_NOTE = 'O convite anterior para este e-mail deixou de valer.';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How long the link just sent stays valid, read from the API's own `expiresAt` instead of a screen
 * constant: the server owns the deadline, and the confirmation would otherwise promise seven days
 * even if the invitation policy changed.
 */
export const inviteLinkDays = (expiresAt: string, now: Date = new Date()): number =>
  Math.max(1, Math.round((new Date(expiresAt).getTime() - now.getTime()) / DAY_MS));

interface SentInvite {
  readonly email: string;
  readonly days: number;
  /** The e-mail already had a pending invitation, which this creation revoked (issue #32). */
  readonly superseded: boolean;
}

/** Validation issues carry the field path the API refused; only that field is marked. */
const refusedField = (details: unknown): 'email' | 'roleId' | undefined => {
  const parsed = z.object({ issues: z.array(z.object({ path: z.string() })) }).safeParse(details);
  if (!parsed.success) return undefined;
  if (parsed.data.issues.some((issue) => issue.path === 'email' || issue.path.startsWith('email.'))) return 'email';
  if (parsed.data.issues.some((issue) => issue.path === 'roleId' || issue.path.startsWith('roleId.'))) return 'roleId';
  return undefined;
};

/**
 * The invite modal (specs/colaboradores.md §7): e-mail and role, nothing else. `Admin` is only
 * offered to the Owner -- the API hides it too, and the RLS policy refuses it for anyone else, so
 * hiding it here is convenience, not the barrier. A successful creation invalidates the pending
 * invitations list, so the new invite appears behind the modal without a reload.
 */
export function InviteCollaboratorDialog({ onClose }: { onClose: () => void }) {
  const agency = useAgencyContext();
  const httpClient = useApiClient();
  const queryClient = useQueryClient();
  const emailId = useId();
  const emailErrorId = useId();
  const roleHintId = useId();
  const roleErrorId = useId();
  const [email, setEmail] = useState('');
  const [roleId, setRoleId] = useState('');
  const [emailError, setEmailError] = useState<string | undefined>();
  const [roleError, setRoleError] = useState<string | undefined>();
  const [formError, setFormError] = useState<string | undefined>();
  const [sent, setSent] = useState<SentInvite | null>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  // `autoFocus` would run before `Modal` captures the previous focus and break the focus return; focusing from an effect runs after that capture.
  useEffect(() => {
    if (sent === null) emailRef.current?.focus();
    else closeRef.current?.focus();
  }, [sent]);

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

  const applyError = (error: unknown): void => {
    if (!(error instanceof HttpClientError)) { setFormError(SEND_FAILED); return; }
    if (error.code === 'MEMBERSHIP_EXISTS') { setEmailError(EMAIL_ALREADY_MEMBER); return; }
    if (error.code === 'INVALID_ROLE') { setRoleError(ROLE_INVALID); return; }
    if (error.code === 'FORBIDDEN' || error.status === 403) { setFormError(NO_PERMISSION); return; }
    if (error.status === 400) {
      const field = refusedField(error.details);
      if (field === 'email') setEmailError(EMAIL_INVALID);
      else if (field === 'roleId') setRoleError(ROLE_INVALID);
      else setFormError(VALIDATION_FAILED);
      return;
    }
    setFormError(SEND_FAILED);
  };

  const send = useMutation({
    mutationFn: ({ email: target, roleId: targetRole }: { email: string; roleId: string }) => httpClient.request({
      path: apiPath('/agencies/:agenciaId/invitations/collaborators', { agenciaId: agency.agencyId }),
      method: 'POST',
      body: { email: target, roleId: targetRole },
      response: CollaboratorInvitationCreatedResponseSchema
    }),
    onSuccess: (created, input) => {
      setSent({ email: input.email, days: inviteLinkDays(created.expiresAt), superseded: created.supersededInvitationId !== null });
    },
    onError: (error: unknown) => { applyError(error); },
    // The API commits the invitation before it sends the e-mail: a 502 leaves a real invitation
    // behind, so the list refetches on settle to show what the server actually holds.
    onSettled: () => { void queryClient.invalidateQueries({ queryKey: ['agency', agency.agencyId, 'invitations'] }); }
  });

  const canSubmit = email.trim() !== '' && roleId !== '';

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const target = email.trim().toLowerCase();
    if (target === '') { setEmailError(EMAIL_REQUIRED); return; }
    if (!AuthEmailSchema.safeParse(target).success) { setEmailError(EMAIL_INVALID); return; }
    if (roleId === '') { setRoleError(ROLE_REQUIRED); return; }
    send.mutate({ email: target, roleId });
  };

  if (sent !== null) {
    return <Modal title="Convidar colaborador" closeLabel="Fechar convite de colaborador" onClose={onClose}>
      <div className="form-stack">
        <LiveStatus>Convite enviado para {sent.email}. O link vale por {sent.days} dias.</LiveStatus>
        {sent.superseded && <p className="form-hint">{SUPERSEDED_NOTE}</p>}
        <div className="form-actions">
          <Button ref={closeRef} onClick={onClose}>Fechar</Button>
        </div>
      </div>
    </Modal>;
  }

  return <Modal title="Convidar colaborador" closeLabel="Fechar convite de colaborador" onClose={onClose}>
    <form className="form-stack" onSubmit={onSubmit} noValidate>
      <div className="form-field">
        <label htmlFor={emailId}>E-mail</label>
        <TextInput
          ref={emailRef}
          id={emailId}
          name="email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(event) => { setEmail(event.target.value); setEmailError(undefined); setFormError(undefined); }}
          aria-invalid={emailError !== undefined}
          aria-describedby={emailError === undefined ? undefined : emailErrorId}
        />
        {emailError !== undefined && <FieldMessage id={emailErrorId} role="alert">{emailError}</FieldMessage>}
      </div>

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
        <Button type="submit" disabled={!canSubmit} loading={send.isPending}>Enviar convite</Button>
      </div>
    </form>
  </Modal>;
}
