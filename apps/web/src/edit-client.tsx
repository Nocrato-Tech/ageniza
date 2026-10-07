import { useEffect, useId, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';

import {
  AuthNoContentResponseSchema,
  ClientNameSchema,
  ClientSchema,
  PROFILE_PHOTO_ACCEPTED_MIME_TYPES,
  PROFILE_PHOTO_MAX_BYTES,
  UploadClientPhotoResponseSchema,
  type ClientDetailResponse,
  type UpdateClientRequest
} from '@ageniza/contracts';
import { Avatar, Button, FieldMessage, LiveStatus, Modal, TextInput } from '@ageniza/ui';

import { useAgencyContext } from './agency.js';
import { apiPath } from './api-path.js';
import { clientDetailQueryKey } from './client-detail.js';
import { HttpClientError, useApiClient } from './http.js';

const NAME_REQUIRED = 'Informe o nome do cliente.';
const NAME_INVALID = 'O nome contém caracteres que não são aceitos.';
const NAME_IN_USE = 'Já existe um cliente ativo com este nome.';
const VALIDATION_FAILED = 'Revise os dados informados.';
const NO_PERMISSION = 'Você não tem permissão para editar este cliente.';
const NOT_FOUND = 'Cliente não encontrado.';
const SAVE_FAILED = 'Não foi possível salvar o cliente. Tente de novo.';
const CONTACT_NOTE = 'Este é o contato da empresa. Quem entra no portal é definido na aba Acessos.';
const PHOTO_TYPE_REJECTED = 'Formato não aceito. Envie uma foto PNG, JPEG, GIF ou WebP.';
const PHOTO_TOO_LARGE = 'A foto passa do tamanho máximo aceito.';
const PHOTO_UPLOAD_FAILED = 'Não foi possível enviar a foto. Tente de novo.';
const PHOTO_REMOVE_FAILED = 'Não foi possível remover a foto. Tente de novo.';

/** One message per registration field, shown when the API refuses that field (issue #137). */
const FIELD_ERRORS: Readonly<Record<string, string>> = {
  name: NAME_INVALID,
  legalName: 'A razão social contém caracteres que não são aceitos.',
  taxId: 'CNPJ ou CPF deve ter 11 ou 14 dígitos.',
  segment: 'O segmento contém caracteres que não são aceitos.',
  website: 'O site deve ser uma URL http(s).',
  instagramHandle: 'O Instagram deve ter o formato de um perfil.',
  contactName: 'O nome do contato contém caracteres que não são aceitos.',
  contactPhone: 'O telefone contém caracteres que não são aceitos.',
  contactEmail: 'O e-mail de contato é inválido.'
};

interface RegistrationFields {
  readonly name: string;
  readonly instagramHandle: string;
  readonly legalName: string;
  readonly taxId: string;
  readonly segment: string;
  readonly website: string;
  readonly contactName: string;
  readonly contactPhone: string;
  readonly contactEmail: string;
}

const emptyIfNull = (value: string | null): string => value ?? '';

const fromClient = (client: ClientDetailResponse): RegistrationFields => ({
  name: client.name,
  instagramHandle: emptyIfNull(client.instagramHandle),
  legalName: emptyIfNull(client.legalName),
  taxId: emptyIfNull(client.taxId),
  segment: emptyIfNull(client.segment),
  website: emptyIfNull(client.website),
  contactName: emptyIfNull(client.contactName),
  contactPhone: emptyIfNull(client.contactPhone),
  contactEmail: emptyIfNull(client.contactEmail)
});

/**
 * The fields that really changed, with the shape each one travels in: Instagram loses its `@`
 * (the column stores it without), CNPJ/CPF loses only the mask (`.` `-` `/` and spaces; letters
 * stay, so the API rejects them on the field instead of a silent `null` clearing the document —
 * review of #379), and a cleared field becomes `null` instead of an empty string (§3).
 */
const changedFields = (client: ClientDetailResponse, fields: RegistrationFields): UpdateClientRequest => {
  const body: UpdateClientRequest = {};
  const name = fields.name.trim();
  if (name !== client.name) body.name = name;
  const instagramHandle = fields.instagramHandle.trim().replace(/^@/, '');
  if (instagramHandle !== (client.instagramHandle ?? '')) body.instagramHandle = instagramHandle === '' ? null : instagramHandle;
  const taxId = fields.taxId.replace(/[.\-/\s]/g, '');
  if (taxId !== (client.taxId ?? '')) body.taxId = taxId === '' ? null : taxId;
  const legalName = fields.legalName.trim();
  if (legalName !== (client.legalName ?? '')) body.legalName = legalName === '' ? null : legalName;
  const segment = fields.segment.trim();
  if (segment !== (client.segment ?? '')) body.segment = segment === '' ? null : segment;
  const website = fields.website.trim();
  if (website !== (client.website ?? '')) body.website = website === '' ? null : website;
  const contactName = fields.contactName.trim();
  if (contactName !== (client.contactName ?? '')) body.contactName = contactName === '' ? null : contactName;
  const contactPhone = fields.contactPhone.trim();
  if (contactPhone !== (client.contactPhone ?? '')) body.contactPhone = contactPhone === '' ? null : contactPhone;
  const contactEmail = fields.contactEmail.trim();
  if (contactEmail !== (client.contactEmail ?? '')) body.contactEmail = contactEmail === '' ? null : contactEmail;
  return body;
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
 *  declared type outside the allowlist is refused before the upload. */
const isRefusedPhotoType = (type: string): boolean =>
  type !== '' && !(PROFILE_PHOTO_ACCEPTED_MIME_TYPES as readonly string[]).includes(type);

/** Validation issues carry the field path the API refused; only that field is marked. */
const refusedFields = (details: unknown): string[] => {
  const parsed = z.object({ issues: z.array(z.object({ path: z.string() })) }).safeParse(details);
  if (!parsed.success) return [];
  return parsed.data.issues.map((issue) => issue.path);
};

/**
 * The edit modal (`specs/clientes.md` §7, issue #137): the whole registration plus the photo,
 * each with its own state. `Salvar` sends only the changed fields and `null` for a cleared one;
 * a success updates the detail behind the modal and invalidates the roster and the portal, so the
 * new name appears everywhere without a reload (SPEC §6 invalidation table). The photo upload and
 * removal never touch the save button's state.
 */
export function EditClientDialog({ client, onClose }: { client: ClientDetailResponse; onClose: () => void }) {
  const agency = useAgencyContext();
  const httpClient = useApiClient();
  const queryClient = useQueryClient();
  const nameRef = useRef<HTMLInputElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const formErrorId = useId();
  const [fields, setFields] = useState<RegistrationFields>(() => fromClient(client));
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<keyof RegistrationFields, string>>>({});
  const [formError, setFormError] = useState<string | undefined>();
  const [photoUrl, setPhotoUrl] = useState<string | null>(client.photoUrl);
  const [photoError, setPhotoError] = useState<string | undefined>();
  const [progress, setProgress] = useState<number | null>(null);
  const [dirty, setDirty] = useState(false);

  useEffect(() => { nameRef.current?.focus(); }, []);

  const setField = (field: keyof RegistrationFields, value: string): void => {
    setFields((current) => ({ ...current, [field]: value }));
    setDirty(true);
    setFieldErrors((current) => (current[field] === undefined ? current : { ...current, [field]: undefined }));
    setFormError(undefined);
  };

  const setFieldError = (field: keyof RegistrationFields, message: string): void => {
    setFieldErrors((current) => ({ ...current, [field]: message }));
  };

  // A photo upload or removal answers with a new `client` (setQueryData), and any refetch can
  // answer while the modal is open. The fields follow the server only while the person has not
  // typed anything: once dirty, the draft survives the photo state (review of #379).
  useEffect(() => {
    if (!dirty) setFields(fromClient(client));
  }, [client, dirty]);

  // `specs/clientes.md` §6: editing the registration or the photo invalidates the listing and the
  // detail (the detail key is a prefix child of the listing key, so one invalidation covers both).
  // The portal's own client query does not exist yet; the portal screen (#141) will invalidate it
  // when it lands — recorded in the SPEC table, not faked here (review of #379).
  const invalidateAfterClientWrite = (agencyId: string): void => {
    void queryClient.invalidateQueries({ queryKey: ['agency', agencyId, 'clients'] });
  };

  const applySaveError = (error: unknown): void => {
    if (!(error instanceof HttpClientError)) { setFormError(SAVE_FAILED); return; }
    if (error.code === 'CLIENT_NAME_IN_USE') { setFieldError('name', NAME_IN_USE); return; }
    if (error.code === 'FORBIDDEN' || error.status === 403) { setFormError(NO_PERMISSION); return; }
    if (error.status === 404) { setFormError(NOT_FOUND); return; }
    if (error.status === 400) {
      const refused = refusedFields(error.details);
      const fields = Object.keys(FIELD_ERRORS).filter((field) =>
        refused.some((path) => path === field || path.startsWith(`${field}.`))) as Array<keyof RegistrationFields>;
      if (fields.length > 0) {
        for (const field of fields) setFieldError(field, FIELD_ERRORS[field]);
        return;
      }
      setFormError(VALIDATION_FAILED);
      return;
    }
    setFormError(SAVE_FAILED);
  };

  const save = useMutation({
    mutationFn: (body: UpdateClientRequest) => httpClient.request({
      path: apiPath('/agencies/:agencyId/clients/:clientId', { agencyId: agency.agencyId, clientId: client.id }),
      method: 'PATCH',
      body,
      response: ClientSchema
    }),
    onSuccess: (updated) => {
      queryClient.setQueryData<ClientDetailResponse>(clientDetailQueryKey(agency.agencyId, client.id), (current) =>
        current === undefined ? current : { ...current, ...updated });
      invalidateAfterClientWrite(agency.agencyId);
      // The SPEC's "o modal não fecha" is about the error state; a save that landed closes the
      // dialog over the updated detail (review of #379).
      onClose();
    },
    onError: (error: unknown) => { applySaveError(error); }
  });

  const upload = useMutation({
    mutationFn: (imageBase64: string) => httpClient.request({
      path: apiPath('/agencies/:agencyId/clients/:clientId/photo', { agencyId: agency.agencyId, clientId: client.id }),
      method: 'PUT',
      body: { imageBase64 },
      response: UploadClientPhotoResponseSchema
    }),
    onSuccess: (response) => {
      setProgress(null);
      setPhotoError(undefined);
      setPhotoUrl(response.photoUrl);
      queryClient.setQueryData<ClientDetailResponse>(clientDetailQueryKey(agency.agencyId, client.id), (current) =>
        current === undefined ? current : { ...current, photoUrl: response.photoUrl });
      invalidateAfterClientWrite(agency.agencyId);
    },
    onError: (error: unknown) => {
      setProgress(null);
      setPhotoError(photoUploadError(error));
    }
  });

  const remove = useMutation({
    mutationFn: () => httpClient.request({
      path: apiPath('/agencies/:agencyId/clients/:clientId/photo', { agencyId: agency.agencyId, clientId: client.id }),
      method: 'DELETE',
      response: AuthNoContentResponseSchema
    }),
    onSuccess: () => {
      setPhotoError(undefined);
      setPhotoUrl(null);
      queryClient.setQueryData<ClientDetailResponse>(clientDetailQueryKey(agency.agencyId, client.id), (current) =>
        current === undefined ? current : { ...current, photoUrl: null });
      invalidateAfterClientWrite(agency.agencyId);
    },
    onError: () => { setPhotoError(PHOTO_REMOVE_FAILED); }
  });

  const readAndUpload = (file: File): void => {
    setPhotoError(undefined);
    setProgress(0);
    const reader = new FileReader();
    reader.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) setProgress(Math.round((event.loaded / event.total) * 100));
    };
    reader.onerror = () => { setProgress(null); setPhotoError(PHOTO_UPLOAD_FAILED); };
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string') { setProgress(null); setPhotoError(PHOTO_UPLOAD_FAILED); return; }
      upload.mutate(result.slice(result.indexOf(',') + 1));
    };
    reader.readAsDataURL(file);
  };

  const onFileChange = (event: ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0];
    // Clearing the value lets the same file be picked again after a refusal.
    event.target.value = '';
    if (file === undefined) return;
    setPhotoError(undefined);
    if (isRefusedPhotoType(file.type)) { setPhotoError(PHOTO_TYPE_REJECTED); return; }
    if (file.size > PROFILE_PHOTO_MAX_BYTES) { setPhotoError(PHOTO_TOO_LARGE); return; }
    readAndUpload(file);
  };

  const body = changedFields(client, fields);
  const hasChanges = Object.keys(body).length > 0;
  const uploading = progress !== null;

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const name = fields.name.trim();
    if (name === '') { setFieldError('name', NAME_REQUIRED); return; }
    if (!ClientNameSchema.safeParse(name).success) { setFieldError('name', NAME_INVALID); return; }
    save.mutate(body);
  };

  const field = (fieldName: keyof RegistrationFields, label: string, props: {
    autoFocus?: boolean;
    placeholder?: string;
    type?: string;
    inputMode?: 'url' | 'email' | 'tel';
    maxLength?: number;
  } = {}) => {
    const id = `${fieldName}-${client.id}`;
    const error = fieldErrors[fieldName];
    const errorMessageId = error === undefined ? undefined : `${id}-error`;
    return <div className="form-field">
      <label htmlFor={id}>{label}</label>
      <TextInput
        ref={fieldName === 'name' ? nameRef : undefined}
        id={id}
        name={fieldName}
        value={fields[fieldName]}
        onChange={(event) => setField(fieldName, event.target.value)}
        aria-invalid={error !== undefined}
        aria-describedby={errorMessageId}
        {...props}
      />
      {error !== undefined && <FieldMessage id={errorMessageId} role="alert">{error}</FieldMessage>}
    </div>;
  };

  return <Modal title="Editar cliente" closeLabel="Fechar edição do cliente" onClose={onClose}>
    <div className="edit-client__photo">
      <Avatar name={client.name} photoUrl={photoUrl} size="lg" />
      <div className="edit-client__photo-actions">
        <input
          ref={inputRef}
          type="file"
          accept={PROFILE_PHOTO_ACCEPTED_MIME_TYPES.join(',')}
          className="edit-client__photo-input"
          tabIndex={-1}
          aria-label="Escolher foto"
          onChange={onFileChange}
        />
        <Button size="sm" variant="secondary" disabled={uploading} onClick={() => inputRef.current?.click()}>Trocar foto</Button>
        {photoUrl !== null && <Button size="sm" variant="ghost" disabled={uploading || remove.isPending} loading={remove.isPending} onClick={() => remove.mutate()}>Remover</Button>}
      </div>
      {uploading && <progress className="edit-client__photo-progress" max={100} value={upload.isPending ? undefined : progress ?? undefined} aria-label="Progresso do envio da foto" />}
      {uploading && <LiveStatus>{upload.isPending ? 'Enviando foto…' : `Preparando foto… ${progress ?? 0}%`}</LiveStatus>}
      {photoError !== undefined && <FieldMessage role="alert">{photoError}</FieldMessage>}
    </div>

    <form className="form-stack" onSubmit={onSubmit} noValidate>
      <div className="edit-client__group">
        <h3>Cliente</h3>
        {field('name', 'Nome')}
        {field('instagramHandle', 'Instagram', { placeholder: '@' })}
      </div>
      <div className="edit-client__group">
        <h3>Empresa</h3>
        {field('legalName', 'Razão social')}
        {field('taxId', 'CNPJ ou CPF')}
        {field('segment', 'Segmento')}
        {field('website', 'Site', { type: 'url', inputMode: 'url' })}
      </div>
      <div className="edit-client__group">
        <h3>Contato do dono</h3>
        {field('contactName', 'Nome')}
        {field('contactPhone', 'Telefone', { inputMode: 'tel' })}
        {field('contactEmail', 'E-mail', { type: 'email', inputMode: 'email' })}
        <p className="form-hint">{CONTACT_NOTE}</p>
      </div>

      {formError !== undefined && <FieldMessage id={formErrorId} role="alert">{formError}</FieldMessage>}

      <div className="form-actions">
        <Button type="submit" disabled={!hasChanges} loading={save.isPending}>Salvar</Button>
      </div>
    </form>
  </Modal>;
}