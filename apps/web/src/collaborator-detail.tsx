import { useEffect, useId, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';

import {
  CollaboratorSchema,
  DISPLAY_NAME_MAX_LENGTH,
  DisplayNameSchema,
  PROFILE_PHOTO_ACCEPTED_MIME_TYPES,
  PROFILE_PHOTO_MAX_BYTES,
  UpdateMyProfileResponseSchema,
  UploadMyPhotoResponseSchema,
  type Collaborator
} from '@ageniza/contracts';
import { Avatar, Button, FieldMessage, LiveStatus, Modal, Skeleton, TextInput } from '@ageniza/ui';

import { useAgencyContext } from './agency.js';
import { apiPath } from './api-path.js';
import { useAuthSession, useOptionalAuthSessionStore, type AuthSessionStore } from './auth.js';
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

const fallbackAuthSnapshot = { status: 'ready' as const, isAuthenticated: false, user: null };
const fallbackAuthStore: AuthSessionStore = {
  subscribe: () => () => undefined,
  getSnapshot: () => fallbackAuthSnapshot,
  refresh: async () => undefined,
  end: () => undefined,
  dispose: () => undefined
};

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

function CollaboratorDetails({ collaborator, isSelf }: { collaborator: Collaborator; isSelf: boolean }) {
  const tabId = useId();
  const panelId = useId();
  const membershipId = collaborator.membershipId.toLowerCase();

  return <>
    {isSelf
      ? <div className="collaborator-detail__identity">
        <SelfProfilePhoto collaborator={collaborator} membershipId={membershipId} />
        {/* The name is already the modal heading; repeating it here would show it twice. */}
        <div className="collaborator-detail__self">
          <p className="form-hint">{PHOTO_IS_GLOBAL}</p>
        </div>
      </div>
      : <div className="collaborator-detail__identity">
        <Avatar name={collaborator.name} photoUrl={collaborator.photoUrl} size="lg" />
        <div>
          <p>{[collaborator.jobTitle, collaborator.role.name].filter(Boolean).join(' · ')}</p>
          <p>{collaborator.email}</p>
          <p>Na agência desde <time dateTime={collaborator.joinedAt}>{new Intl.DateTimeFormat('pt-BR').format(new Date(collaborator.joinedAt))}</time></p>
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
        : <dl className="collaborator-detail__fields">
          <dt>Cargo</dt><dd>{collaborator.jobTitle ?? 'Não informado'}</dd>
          <dt>Papel</dt><dd>{collaborator.role.name}</dd>
          <dt>E-mail</dt><dd>{collaborator.email}<p className="form-hint">{EMAIL_NOTE}</p></dd>
        </dl>}
    </div>
  </>;
}

export function CollaboratorDetailDialog({ membershipId, onClose }: { membershipId: string; onClose: () => void }) {
  const agency = useAgencyContext();
  const httpClient = useApiClient();
  const authStore = useOptionalAuthSessionStore();
  const session = useAuthSession(authStore ?? fallbackAuthStore);
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
  // Name and photo belong to the global user; the only identity the membership detail carries is
  // the e-mail, and the session owns the same canonical e-mail for the signed-in person. The
  // comparison is provisional: the API will say whether the link is the signed-in person's own
  // (#286), and this e-mail heuristic leaves with it.
  const isSelf = collaborator !== undefined && session.user !== null && session.user.email === collaborator.email;

  return <Modal title={collaborator?.name ?? 'Detalhe do colaborador'} closeLabel="Fechar detalhe do colaborador" onClose={onClose}>
    {notFound ? <div className="collaborator-detail__status">
      <p>Colaborador não encontrado.</p>
      <Button variant="secondary" onClick={onClose}>Voltar à lista</Button>
    </div> : <>
      {detail.isError || (detail.data !== undefined && collaborator === undefined) ? <div role="alert" className="collaborator-detail__status">
        <p>Não foi possível carregar o colaborador. Tente de novo.</p>
        <Button onClick={() => { void detail.refetch(); }} loading={detail.isFetching}>Tentar de novo</Button>
      </div> : null}
      {collaborator !== undefined ? <CollaboratorDetails collaborator={collaborator} isSelf={isSelf} /> : detail.isPending ? <div className="collaborator-detail__status">
        <LiveStatus>Carregando colaborador…</LiveStatus>
        <Skeleton /><Skeleton />
      </div> : null}
    </>}
  </Modal>;
}
