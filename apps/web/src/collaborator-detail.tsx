import { useEffect, useId, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { z } from 'zod';

import {
  AgencyRolesResponseSchema,
  COLLABORATOR_JOB_TITLE_MAX_LENGTH,
  CollaboratorSchema,
  DISPLAY_NAME_MAX_LENGTH,
  DisplayNameSchema,
  PROFILE_PHOTO_ACCEPTED_MIME_TYPES,
  PROFILE_PHOTO_MAX_BYTES,
  UpdateMyProfileResponseSchema,
  UploadMyPhotoResponseSchema,
  type Collaborator,
  type UpdateCollaboratorRequest
} from '@ageniza/contracts';
import { Avatar, Button, ConfirmDialog, FieldMessage, LiveStatus, Modal, Select, Skeleton, TextInput } from '@ageniza/ui';

import { useAgencyContext, useCan } from './agency.js';
import { apiPath } from './api-path.js';
import { useOptionalAuthSessionStore } from './auth.js';
import { HttpClientError, useApiClient } from './http.js';

const NAME_REQUIRED = 'Informe o seu nome.';
const NAME_TOO_LONG = `O nome pode ter no máximo ${DISPLAY_NAME_MAX_LENGTH} caracteres.`;
const NAME_REJECTED = 'O nome contém caracteres que não são aceitos.';
const PROFILE_SAVE_FAILED = 'Não foi possível salvar o nome. Tente de novo.';
const PHOTO_TYPE_REJECTED = 'Formato não aceito. Envie uma foto PNG, JPEG, GIF ou WebP.';
const PHOTO_TOO_LARGE = 'A foto passa do tamanho máximo aceito.';
const PHOTO_UPLOAD_FAILED = 'Não foi possível enviar a foto. Tente de novo.';
const JOB_TITLE_NOTE = 'Quem administra a agência define o cargo.';
const EMAIL_NOTE = 'A troca de e-mail é feita pela operação.';
const UNAVAILABLE_REASON = 'Disponível quando o módulo de Tarefas existir.';
const PHOTO_IS_GLOBAL = 'Esta foto aparece nos seus crachás em todas as agências.';
const JOB_TITLE_INVALID = 'O cargo contém caracteres que não são aceitos.';
const ROLE_INVALID = 'Escolha um papel da lista.';
const ADMIN_VALIDATION_FAILED = 'Revise os dados informados.';
const ADMIN_SAVE_FAILED = 'Não foi possível salvar as alterações. Tente de novo.';
const ADMIN_FORBIDDEN = 'Você não tem permissão para alterar este colaborador.';
const ADMIN_NOT_FOUND = 'Colaborador não encontrado.';
const REMOVE_FORBIDDEN = 'Você não tem permissão para remover este colaborador.';
const REMOVE_ALREADY = 'Este colaborador já foi removido.';
const REMOVE_NOT_FOUND = 'Colaborador não encontrado.';
const REMOVE_FAILED = 'Não foi possível remover este colaborador. Tente de novo.';
const REMOVE_DESCRIPTION = 'A pessoa perde o acesso a esta agência na próxima requisição. O registro é mantido, e ela pode ser reativada depois — com um papel escolhido de novo.';
const ROLES_FAILED = 'Não foi possível carregar os papéis. Tente de novo.';

const detailQueryKey = (agencyId: string, membershipId: string) =>
  ['agency', agencyId, 'collaborators', 'detail', membershipId] as const;

/**
 * Name and photo belong to the global user, not to one membership (specs/colaboradores.md §3):
 * after either changes, every agency's cached collaborator data is stale, not just the one the
 * modal was opened from.
 */
const invalidateEveryAgencyCollaborators = (queryClient: QueryClient): void => {
  void queryClient.invalidateQueries({
    predicate: (query) => query.queryKey[0] === 'agency' && query.queryKey[2] === 'collaborators'
  });
};

/**
 * Cargo, papel and status belong to the membership (specs/colaboradores.md §3), so only the agency
 * the modal was opened from has stale collaborator data after a change.
 */
const invalidateAgencyCollaborators = (queryClient: QueryClient, agencyId: string): void => {
  void queryClient.invalidateQueries({ queryKey: ['agency', agencyId, 'collaborators'] });
};

/** Mirrors `UpdateMyProfileRequestSchema` before a byte leaves the browser; the API validates again. */
const validateName = (value: string): string | undefined => {
  const trimmed = value.trim();
  if (trimmed === '') return NAME_REQUIRED;
  if (trimmed.length > DISPLAY_NAME_MAX_LENGTH) return NAME_TOO_LONG;
  return DisplayNameSchema.safeParse(value).success ? undefined : NAME_REJECTED;
};

/** The API distinguishes the two refusals by status; the screen has to say which one happened. */
const photoUploadError = (error: unknown): string => {
  if (error instanceof HttpClientError) {
    if (error.status === 413 || error.code === 'PAYLOAD_TOO_LARGE') return PHOTO_TOO_LARGE;
    if (error.status === 415 || error.code === 'UNSUPPORTED_MEDIA_TYPE') return PHOTO_TYPE_REJECTED;
  }
  return PHOTO_UPLOAD_FAILED;
};

/** An empty browser-reported type proves nothing -- the API decides by the bytes -- so only a
 * declared type outside the allowlist is refused before the upload. */
const isRefusedPhotoType = (type: string): boolean =>
  type !== '' && !(PROFILE_PHOTO_ACCEPTED_MIME_TYPES as readonly string[]).includes(type);

/** Validation issues carry the field path the API refused; only that field is marked. */
const refusedField = (details: unknown): 'jobTitle' | 'roleId' | undefined => {
  const parsed = z.object({ issues: z.array(z.object({ path: z.string() })) }).safeParse(details);
  if (!parsed.success) return undefined;
  if (parsed.data.issues.some((issue) => issue.path === 'jobTitle' || issue.path.startsWith('jobTitle.'))) return 'jobTitle';
  if (parsed.data.issues.some((issue) => issue.path === 'roleId' || issue.path.startsWith('roleId.'))) return 'roleId';
  return undefined;
};

function SelfProfilePhoto({ collaborator, membershipId }: { collaborator: Collaborator; membershipId: string }) {
  const agency = useAgencyContext();
  const httpClient = useApiClient();
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | undefined>();

  const upload = useMutation({
    mutationFn: (imageBase64: string) => httpClient.request({
      path: '/me/photo',
      method: 'POST',
      body: { imageBase64 },
      response: UploadMyPhotoResponseSchema
    }),
    onSuccess: (response) => {
      setProgress(null);
      setError(undefined);
      queryClient.setQueryData<Collaborator>(detailQueryKey(agency.agencyId, membershipId), (current) =>
        current === undefined ? current : { ...current, photoUrl: response.imageUrl });
      // The uploaded photo is the user's, so every agency's collaborator data behind the modal
      // shows the old one until it is invalidated, not only the agency the modal was opened from.
      invalidateEveryAgencyCollaborators(queryClient);
    },
    onError: (uploadError: unknown) => {
      setProgress(null);
      setError(photoUploadError(uploadError));
    }
  });

  const readAndUpload = (file: File): void => {
    setError(undefined);
    setProgress(0);
    const reader = new FileReader();
    reader.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) setProgress(Math.round((event.loaded / event.total) * 100));
    };
    reader.onerror = () => { setProgress(null); setError(PHOTO_UPLOAD_FAILED); };
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string') { setProgress(null); setError(PHOTO_UPLOAD_FAILED); return; }
      upload.mutate(result.slice(result.indexOf(',') + 1));
    };
    reader.readAsDataURL(file);
  };

  const onFileChange = (event: ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0];
    // Clearing the value lets the same file be picked again after a refusal.
    event.target.value = '';
    if (file === undefined) return;
    setError(undefined);
    if (isRefusedPhotoType(file.type)) { setError(PHOTO_TYPE_REJECTED); return; }
    if (file.size > PROFILE_PHOTO_MAX_BYTES) { setError(PHOTO_TOO_LARGE); return; }
    readAndUpload(file);
  };

  const uploading = progress !== null;
  return <div className="collaborator-detail__photo">
    <Avatar name={collaborator.name} photoUrl={collaborator.photoUrl} size="lg" />
    <input
      ref={inputRef}
      type="file"
      accept={PROFILE_PHOTO_ACCEPTED_MIME_TYPES.join(',')}
      className="collaborator-detail__photo-input"
      tabIndex={-1}
      aria-label="Escolher foto"
      onChange={onFileChange}
    />
    <Button size="sm" variant="secondary" disabled={uploading} onClick={() => inputRef.current?.click()}>Trocar foto</Button>
    {uploading && <progress className="collaborator-detail__photo-progress" max={100} value={upload.isPending ? undefined : progress ?? undefined} aria-label="Progresso do envio da foto" />}
    {uploading && <LiveStatus>{upload.isPending ? 'Enviando foto…' : `Preparando foto… ${progress ?? 0}%`}</LiveStatus>}
    {error !== undefined && <FieldMessage role="alert">{error}</FieldMessage>}
  </div>;
}

function SelfProfileFields({ collaborator, membershipId }: { collaborator: Collaborator; membershipId: string }) {
  const agency = useAgencyContext();
  const httpClient = useApiClient();
  const queryClient = useQueryClient();
  const authStore = useOptionalAuthSessionStore();
  const nameId = useId();
  const errorId = useId();
  const [name, setName] = useState(collaborator.name);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | undefined>();

  // The detail query can answer again while the modal is open (another tab, a revalidation). The
  // field follows it only while it has no typed value of its own; overwriting a draft would lose
  // what the person wrote.
  useEffect(() => {
    if (!dirty) setName(collaborator.name);
  }, [collaborator.name, dirty]);

  const save = useMutation({
    mutationFn: (nextName: string) => httpClient.request({
      path: '/me/profile',
      method: 'PATCH',
      body: { name: nextName },
      response: UpdateMyProfileResponseSchema
    }),
    onSuccess: (updated) => {
      setName(updated.name);
      setDirty(false);
      setError(undefined);
      // The modal header and the badge behind both read their name from these queries.
      queryClient.setQueryData<Collaborator>(detailQueryKey(agency.agencyId, membershipId), (current) =>
        current === undefined ? current : { ...current, name: updated.name });
      invalidateEveryAgencyCollaborators(queryClient);
      // The account menu shows the session user's name; refreshing it keeps the header coherent.
      void authStore?.refresh();
    },
    onError: () => { setError(PROFILE_SAVE_FAILED); }
  });

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const validationError = validateName(name);
    setError(validationError);
    if (validationError !== undefined) return;
    save.mutate(name.trim());
  };

  return <form className="self-profile" onSubmit={onSubmit} noValidate>
    <div className="form-field">
      <label htmlFor={nameId}>Nome</label>
      <TextInput
        id={nameId}
        name="name"
        autoComplete="name"
        value={name}
        onChange={(event) => { setName(event.target.value); setDirty(true); setError(undefined); }}
        aria-invalid={error !== undefined}
        aria-describedby={error === undefined ? undefined : errorId}
      />
      {error !== undefined && <FieldMessage id={errorId} role="alert">{error}</FieldMessage>}
    </div>
    <div className="self-profile__readonly">
      <p className="self-profile__label">Cargo</p>
      <p>{collaborator.jobTitle ?? 'Não informado'}</p>
      <p className="form-hint">{JOB_TITLE_NOTE}</p>
    </div>
    <div className="self-profile__readonly">
      <p className="self-profile__label">Papel</p>
      <p>{collaborator.role.name}</p>
    </div>
    <div className="self-profile__readonly">
      <p className="self-profile__label">E-mail</p>
      <p>{collaborator.email}</p>
      <p className="form-hint">{EMAIL_NOTE}</p>
    </div>
    <div className="form-actions">
      <Button type="submit" loading={save.isPending}>Salvar</Button>
    </div>
  </form>;
}

function ReadOnlyField({ label, value, note }: { label: string; value: string; note?: string }) {
  return <div className="collaborator-detail__readonly">
    <p className="collaborator-detail__label">{label}</p>
    <p>{value}</p>
    {note !== undefined && <p className="form-hint">{note}</p>}
  </div>;
}

/** SPEC §7: the modal header shows the agency entry date, for the own profile too (#357). */
function AgencySince({ joinedAt }: { joinedAt: string }) {
  return <p>Na agência desde <time dateTime={joinedAt}>{new Intl.DateTimeFormat('pt-BR').format(new Date(joinedAt))}</time></p>;
}

interface AdminEditFieldsProps {
  readonly collaborator: Collaborator;
  readonly membershipId: string;
  readonly canChangeJobTitle: boolean;
  readonly canChangeRole: boolean;
}

/**
 * The administrative half of the detail modal (`specs/colaboradores.md` §7): job title and role,
 * each editable only for the permission its PATCH needs. `Admin` is only offered to the caller who
 * can grant it -- the Owner -- and the API and the RLS barriers refuse it for anyone else; hiding
 * the option is convenience, not the barrier. Saving invalidates the listing so the badge behind
 * reflects the change without a reload.
 */
function AdminEditFields({ collaborator, membershipId, canChangeJobTitle, canChangeRole }: AdminEditFieldsProps) {
  const agency = useAgencyContext();
  const httpClient = useApiClient();
  const queryClient = useQueryClient();
  const canGrantAdmin = useCan('colaborador.atribuir_admin');
  const jobTitleId = useId();
  const jobTitleErrorId = useId();
  const roleErrorId = useId();
  const [jobTitle, setJobTitle] = useState(collaborator.jobTitle ?? '');
  const [roleId, setRoleId] = useState<string | undefined>();
  const [jobTitleError, setJobTitleError] = useState<string | undefined>();
  const [roleError, setRoleError] = useState<string | undefined>();
  const [formError, setFormError] = useState<string | undefined>();

  const roles = useQuery({
    queryKey: ['agency', agency.agencyId, 'roles'],
    queryFn: ({ signal }) => httpClient.request({
      path: apiPath('/agencies/:agenciaId/roles', { agenciaId: agency.agencyId }),
      response: AgencyRolesResponseSchema,
      signal
    }),
    enabled: canChangeRole
  });

  // The server already hides `admin` from a caller who cannot grant it; the extra filter keeps the
  // promise even if that response ever regresses.
  const roleOptions = (roles.data?.data ?? [])
    .filter((role) => canGrantAdmin || role.key !== 'admin')
    .map((role) => ({ value: role.id, label: role.name }));

  const currentRole = roles.data?.data.find((role) => role.key === collaborator.role.key);
  // A current role the list does not offer (an admin target seen by a non-Owner) shows as the
  // placeholder: the screen never presents an option it would refuse to keep.
  const selectedRoleId = roleId ?? (currentRole !== undefined && (canGrantAdmin || currentRole.key !== 'admin') ? currentRole.id : '');
  const initialRoleId = currentRole?.id ?? '';
  const jobTitleChanged = canChangeJobTitle && jobTitle.trim() !== (collaborator.jobTitle ?? '');
  const roleChanged = canChangeRole && roleId !== undefined && roleId !== initialRoleId;

  const applySaveError = (error: unknown): void => {
    if (!(error instanceof HttpClientError)) { setFormError(ADMIN_SAVE_FAILED); return; }
    if (error.code === 'INVALID_ROLE') { setRoleError(ROLE_INVALID); return; }
    if (error.code === 'FORBIDDEN' || error.status === 403) { setFormError(ADMIN_FORBIDDEN); return; }
    if (error.status === 404) { setFormError(ADMIN_NOT_FOUND); return; }
    if (error.status === 400) {
      const field = refusedField(error.details);
      if (field === 'jobTitle') setJobTitleError(JOB_TITLE_INVALID);
      else if (field === 'roleId') setRoleError(ROLE_INVALID);
      else setFormError(ADMIN_VALIDATION_FAILED);
      return;
    }
    setFormError(ADMIN_SAVE_FAILED);
  };

  const save = useMutation({
    mutationFn: (body: UpdateCollaboratorRequest) => httpClient.request({
      path: apiPath('/agencies/:agencyId/collaborators/:membershipId', { agencyId: agency.agencyId, membershipId }),
      method: 'PATCH',
      body,
      response: CollaboratorSchema
    }),
    onSuccess: (updated) => {
      setJobTitle(updated.jobTitle ?? '');
      setRoleId(undefined);
      setJobTitleError(undefined);
      setRoleError(undefined);
      setFormError(undefined);
      queryClient.setQueryData<Collaborator>(detailQueryKey(agency.agencyId, membershipId), updated);
      invalidateAgencyCollaborators(queryClient, agency.agencyId);
    },
    onError: (error: unknown) => { applySaveError(error); }
  });

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const body: UpdateCollaboratorRequest = {};
    if (jobTitleChanged) body.jobTitle = jobTitle.trim() === '' ? null : jobTitle.trim();
    if (roleChanged) body.roleId = roleId;
    save.mutate(body);
  };

  return <form className="form-stack" onSubmit={onSubmit} noValidate>
    {canChangeJobTitle
      ? <div className="form-field">
        <label htmlFor={jobTitleId}>Cargo</label>
        <TextInput
          id={jobTitleId}
          name="jobTitle"
          value={jobTitle}
          maxLength={COLLABORATOR_JOB_TITLE_MAX_LENGTH}
          onChange={(event) => { setJobTitle(event.target.value); setJobTitleError(undefined); setFormError(undefined); }}
          aria-invalid={jobTitleError !== undefined}
          aria-describedby={jobTitleError === undefined ? undefined : jobTitleErrorId}
        />
        {jobTitleError !== undefined && <FieldMessage id={jobTitleErrorId} role="alert">{jobTitleError}</FieldMessage>}
      </div>
      : <ReadOnlyField label="Cargo" value={collaborator.jobTitle ?? 'Não informado'} />}

    {canChangeRole
      ? <div className="form-field">
        <Select
          label="Papel"
          value={selectedRoleId}
          placeholder="Selecione"
          options={roleOptions}
          disabled={roles.isPending || roles.isError}
          onChange={(value) => { setRoleId(value); setRoleError(undefined); setFormError(undefined); }}
          aria-invalid={roleError !== undefined}
          aria-describedby={roleError === undefined ? undefined : roleErrorId}
        />
        {roleError !== undefined && <FieldMessage id={roleErrorId} role="alert">{roleError}</FieldMessage>}
        {roles.isError && <div className="form-field">
          <FieldMessage role="alert">{ROLES_FAILED}</FieldMessage>
          <Button variant="secondary" size="sm" onClick={() => { void roles.refetch(); }} loading={roles.isFetching}>Tentar de novo</Button>
        </div>}
      </div>
      : <ReadOnlyField label="Papel" value={collaborator.role.name} />}

    <ReadOnlyField label="E-mail" value={collaborator.email} note={EMAIL_NOTE} />

    {formError !== undefined && <FieldMessage role="alert">{formError}</FieldMessage>}

    <div className="form-actions">
      <Button type="submit" disabled={!jobTitleChanged && !roleChanged} loading={save.isPending}>Salvar</Button>
    </div>
  </form>;
}

const removeErrorText = (error: unknown): string => {
  if (error instanceof HttpClientError) {
    if (error.code === 'COLLABORATOR_ALREADY_REMOVED' || error.status === 409) return REMOVE_ALREADY;
    if (error.code === 'FORBIDDEN' || error.status === 403) return REMOVE_FORBIDDEN;
    if (error.status === 404) return REMOVE_NOT_FOUND;
  }
  return REMOVE_FAILED;
};

/** The one destructive action of the screen, separated at the foot of the modal (§7). */
function RemoveCollaborator({ collaborator, membershipId, onRemoved }: { collaborator: Collaborator; membershipId: string; onRemoved: () => void }) {
  const agency = useAgencyContext();
  const httpClient = useApiClient();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const remove = useMutation({
    mutationFn: () => httpClient.request({
      path: apiPath('/agencies/:agencyId/collaborators/:membershipId/remove', { agencyId: agency.agencyId, membershipId }),
      method: 'POST',
      response: CollaboratorSchema
    }),
    onSuccess: () => {
      setConfirming(false);
      queryClient.removeQueries({ queryKey: detailQueryKey(agency.agencyId, membershipId) });
      // The person leaves the default (active) listing; the badge behind must disappear without a reload.
      invalidateAgencyCollaborators(queryClient, agency.agencyId);
      onRemoved();
    },
    onError: (removeError: unknown) => {
      setConfirming(false);
      setError(removeErrorText(removeError));
      // A 409 says the server already removed the link; refresh so the listing stops showing it.
      if (removeError instanceof HttpClientError && (removeError.code === 'COLLABORATOR_ALREADY_REMOVED' || removeError.status === 409)) {
        invalidateAgencyCollaborators(queryClient, agency.agencyId);
      }
    }
  });

  return <div className="collaborator-detail__remove">
    <Button variant="destructive" onClick={() => { setError(undefined); setConfirming(true); }}>Remover do quadro</Button>
    {error !== undefined && <FieldMessage role="alert">{error}</FieldMessage>}
    <ConfirmDialog
      open={confirming}
      title={`Remover ${collaborator.name} do quadro?`}
      description={REMOVE_DESCRIPTION}
      confirmLabel="Remover"
      cancelLabel="Cancelar"
      busy={remove.isPending}
      onConfirm={() => remove.mutate()}
      onCancel={() => { if (!remove.isPending) setConfirming(false); }}
    />
  </div>;
}

function CollaboratorDetails({ collaborator, isSelf, onRemoved }: { collaborator: Collaborator; isSelf: boolean; onRemoved: () => void }) {
  const tabId = useId();
  const panelId = useId();
  const membershipId = collaborator.membershipId.toLowerCase();
  const canAlterJobTitle = useCan('colaborador.alterar_funcao');
  const canChangeRole = useCan('colaborador.alterar_papel');
  const canRemove = useCan('colaborador.remover');
  // SPEC §7: nobody edits the Owner's role or job title, or removes the Owner, through this modal
  // (the API refuses both edits with a 403); the self view has its own fields, so this branch never
  // renders for the signed-in person.
  const canChangeJobTitle = canAlterJobTitle && !collaborator.isOwner;
  const roleEditable = canChangeRole && !collaborator.isOwner;
  const removeOffered = canRemove && !collaborator.isOwner;
  const editable = canChangeJobTitle || roleEditable;

  return <>
    {isSelf
      ? <div className="collaborator-detail__identity">
        <SelfProfilePhoto collaborator={collaborator} membershipId={membershipId} />
        {/* The name is already the modal heading; repeating it here would show it twice. */}
        <div className="collaborator-detail__self">
          <p className="form-hint">{PHOTO_IS_GLOBAL}</p>
          <AgencySince joinedAt={collaborator.joinedAt} />
        </div>
      </div>
      : <div className="collaborator-detail__identity">
        <Avatar name={collaborator.name} photoUrl={collaborator.photoUrl} size="lg" />
        <div>
          <p>{[collaborator.jobTitle, collaborator.role.name].filter(Boolean).join(' · ')}</p>
          <p>{collaborator.email}</p>
          <AgencySince joinedAt={collaborator.joinedAt} />
        </div>
      </div>}
    <div className="collaborator-detail__tabs" role="tablist" aria-label="Informações do colaborador">
      <Button id={tabId} role="tab" aria-selected="true" aria-controls={panelId} variant="secondary">Detalhes</Button>
      {['Performance', 'Entregas'].map((label) => <div key={label} className="collaborator-detail__tab">
        <Button role="tab" aria-selected="false" disabled variant="ghost">{label}</Button>
        <p className="form-hint">{UNAVAILABLE_REASON}</p>
      </div>)}
    </div>
    <div role="tabpanel" id={panelId} aria-labelledby={tabId} tabIndex={0}>
      {isSelf
        ? <SelfProfileFields collaborator={collaborator} membershipId={membershipId} />
        : <>
          {editable
            ? <AdminEditFields
                collaborator={collaborator}
                membershipId={membershipId}
                canChangeJobTitle={canChangeJobTitle}
                canChangeRole={roleEditable}
              />
            : <dl className="collaborator-detail__fields">
              <dt>Cargo</dt><dd>{collaborator.jobTitle ?? 'Não informado'}</dd>
              <dt>Papel</dt><dd>{collaborator.role.name}</dd>
              <dt>E-mail</dt><dd>{collaborator.email}<p className="form-hint">{EMAIL_NOTE}</p></dd>
            </dl>}
          {removeOffered && <RemoveCollaborator collaborator={collaborator} membershipId={membershipId} onRemoved={onRemoved} />}
        </>}
    </div>
  </>;
}

export function CollaboratorDetailDialog({ membershipId, onClose }: { membershipId: string; onClose: () => void }) {
  const agency = useAgencyContext();
  const httpClient = useApiClient();
  const normalizedId = membershipId.toLowerCase();
  const validId = CollaboratorSchema.shape.membershipId.safeParse(normalizedId).success;
  const detail = useQuery({
    queryKey: detailQueryKey(agency.agencyId, normalizedId),
    queryFn: ({ signal }) => httpClient.request({
      path: apiPath('/agencies/:agencyId/collaborators/:membershipId', { agencyId: agency.agencyId, membershipId: normalizedId }),
      response: CollaboratorSchema,
      signal
    }),
    enabled: validId,
    refetchOnMount: 'always'
  });
  const notFound = !validId || (detail.error instanceof HttpClientError && [403, 404].includes(detail.error.status ?? 0));
  const collaborator = !notFound && detail.data?.membershipId.toLowerCase() === normalizedId ? detail.data : undefined;
  // Name and photo belong to the global user, so only the signed-in person's own link edits them;
  // the API says which link that is.
  const isSelf = collaborator?.isSelf === true;

  return <Modal title={collaborator?.name ?? 'Detalhe do colaborador'} closeLabel="Fechar detalhe do colaborador" onClose={onClose}>
    {notFound ? <div className="collaborator-detail__status">
      <p>Colaborador não encontrado.</p>
      <Button variant="secondary" onClick={onClose}>Voltar à lista</Button>
    </div> : <>
      {detail.isError || (detail.data !== undefined && collaborator === undefined) ? <div role="alert" className="collaborator-detail__status">
        <p>Não foi possível carregar o colaborador. Tente de novo.</p>
        <Button onClick={() => { void detail.refetch(); }} loading={detail.isFetching}>Tentar de novo</Button>
      </div> : null}
      {collaborator !== undefined ? <CollaboratorDetails collaborator={collaborator} isSelf={isSelf} onRemoved={onClose} /> : detail.isPending ? <div className="collaborator-detail__status">
        <LiveStatus>Carregando colaborador…</LiveStatus>
        <Skeleton /><Skeleton />
      </div> : null}
    </>}
  </Modal>;
}
