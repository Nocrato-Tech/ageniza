import { useEffect, useId, useRef, useState, type FormEvent, type Ref } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';

import {
  ARCHETYPE_LABELS,
  ArchetypeSchema,
  BrandStudyResponseSchema,
  BrandStudySectionSchema,
  PersonaNameSchema,
  PersonaSchema,
  utf8ByteLength,
  type BrandColor,
  type BrandStudyResponse,
  type ClientDetailResponse,
  type Persona,
  type ThreadSubject
} from '@ageniza/contracts';
import { Button, ConfirmDialog, FieldMessage, Modal, Select, Skeleton, TextInput, Textarea } from '@ageniza/ui';

import { useAgencyContext, useCan } from './agency.js';
import { apiPath } from './api-path.js';
import { clientDetailQueryKey, formatAgencyDayMonth, useClientDetail } from './client-detail.js';
import { Conversation } from './conversation.js';
import { HttpClientError, useApiClient } from './http.js';

const EMPTY_SECTION = 'Ainda não preenchida';
const NOT_INFORMED = 'Não informado';
const LOAD_FAILED = 'Não foi possível carregar o estudo de marca. Tente de novo.';
const SAVE_FAILED = 'Não foi possível salvar. Tente de novo.';
const VALIDATION_FAILED = 'Revise os dados informados.';
const NO_PERMISSION = 'Você não tem permissão para editar o estudo de marca.';
const ARCHIVED_READ_ONLY = 'Cliente arquivado: o estudo de marca está somente leitura.';
const NAME_REQUIRED = 'Informe o nome da persona.';
const NAME_INVALID = 'O nome contém caracteres que não são aceitos.';
const NAME_TOO_LONG = 'O nome da persona pode ter no máximo 120 bytes.';
const COLORS_INVALID = 'Cada cor precisa de um nome e de um código hexadecimal como #7A1F2B.';
const PERSONA_ARCHIVE_DESCRIPTION = 'Ela some do portal e as conversas dela ficam somente leitura. Você pode desarquivar depois.';
const PERSONA_NAME_MAX_BYTES = 120;

/** `specs/clientes.md` §3: the seven fixed sections, always present and always in this order. */
const SECTION_LABELS = {
  branding: 'Branding',
  tone_of_voice: 'Tom de voz',
  colors: 'Cores',
  positioning: 'Posicionamento',
  archetype: 'Arquétipo',
  personas: 'Personas',
  observations: 'Observações'
} as const;

type SectionKey = keyof typeof SECTION_LABELS;
const SECTION_ORDER: readonly SectionKey[] = ['branding', 'tone_of_voice', 'colors', 'positioning', 'archetype', 'personas', 'observations'];
type TextSectionKey = 'branding' | 'tone_of_voice' | 'positioning' | 'observations';

export const brandStudyQueryKey = (agencyId: string, clientId: string) =>
  ['agency', agencyId, 'clients', 'brand-study', clientId] as const;

/** The archetype options: the English key travels, the Portuguese label is what people read (§3). */
const ARCHETYPE_OPTIONS = ArchetypeSchema.options.map((key) => ({ value: key, label: ARCHETYPE_LABELS[key] }));

const HEX_PATTERN = /^#[0-9A-Fa-f]{6}$/;

/** Validation issues carry the field path the API refused; only that field is marked. */
const refusedName = (details: unknown): boolean => {
  const parsed = z.object({ issues: z.array(z.object({ path: z.string() })) }).safeParse(details);
  return parsed.success && parsed.data.issues.some((issue) => issue.path === 'name' || issue.path.startsWith('name.'));
};

const sectionMutationError = (error: unknown): string => {
  if (!(error instanceof HttpClientError)) return SAVE_FAILED;
  if (error.code === 'CLIENT_ARCHIVED') return ARCHIVED_READ_ONLY;
  if (error.code === 'FORBIDDEN' || error.status === 403) return NO_PERMISSION;
  if (error.status === 400) return VALIDATION_FAILED;
  return SAVE_FAILED;
};

/** Invalidates the study (counter/recheck) and the detail's General summary (SPEC §6). */
const invalidateStudyWrites = (queryClient: ReturnType<typeof useQueryClient>, agencyId: string, clientId: string): void => {
  void queryClient.invalidateQueries({ queryKey: brandStudyQueryKey(agencyId, clientId) });
  void queryClient.invalidateQueries({ queryKey: clientDetailQueryKey(agencyId, clientId) });
};

/** The last editor and day of a section, in the agency's timezone (review lessons of #379). */
function UpdatedBy({ section }: { section: { updatedBy: { name: string } | null; updatedAt: string | null } }) {
  if (section.updatedBy === null || section.updatedAt === null) return null;
  return <p className="brand-section__updated">editado por {section.updatedBy.name} · {formatAgencyDayMonth(section.updatedAt)}</p>;
}

/**
 * The conversations of one subject of the study. Writing them also moves the detail's summary and
 * the roster's "aguardando" badge, so both are invalidated here (SPEC section 6).
 */
function StudyConversation({ client, subject, subjectLabel, readOnly, headingLevel }: {
  client: ClientDetailResponse;
  subject: ThreadSubject;
  subjectLabel: string;
  readOnly: boolean;
  headingLevel?: 3 | 4;
}) {
  const agency = useAgencyContext();
  const queryClient = useQueryClient();
  const canOperate = useCan('cliente.operar');
  return <Conversation
    scope={{ side: 'agency', agencyId: agency.agencyId, clientId: client.id }}
    subject={subject}
    subjectLabel={subjectLabel}
    canWrite={canOperate}
    readOnly={readOnly || client.status !== 'active'}
    headingLevel={headingLevel}
    onWritten={() => {
      void queryClient.invalidateQueries({ queryKey: clientDetailQueryKey(agency.agencyId, client.id) });
      void queryClient.invalidateQueries({ queryKey: ['agency', agency.agencyId, 'clients'], predicate: (query) => typeof query.queryKey[3] === 'object' });
    }}
  />;
}

/** The in-place editor of a free-text section (Branding, Tom de voz, Posicionamento, Observações). */
function TextSection({ client, sectionKey, section, canEdit }: {
  client: ClientDetailResponse;
  sectionKey: TextSectionKey;
  section: { body: string | null };
  canEdit: boolean;
}) {
  const agency = useAgencyContext();
  const httpClient = useApiClient();
  const queryClient = useQueryClient();
  const label = SECTION_LABELS[sectionKey];
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | undefined>();
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const save = useMutation({
    mutationFn: (body: string) => httpClient.request({
      path: apiPath('/agencies/:agencyId/clients/:clientId/brand-study/sections/:sectionKey', {
        agencyId: agency.agencyId,
        clientId: client.id,
        sectionKey
      }),
      method: 'PUT',
      body: { body },
      response: BrandStudySectionSchema
    }),
    onSuccess: (updated) => {
      setEditing(false);
      setError(undefined);
      queryClient.setQueryData<BrandStudyResponse>(brandStudyQueryKey(agency.agencyId, client.id), (current) =>
        current === undefined ? current : { ...current, sections: current.sections.map((item) => (item.key === sectionKey ? updated : item)) });
      invalidateStudyWrites(queryClient, agency.agencyId, client.id);
    },
    onError: (saveError: unknown) => { setError(sectionMutationError(saveError)); }
  });

  const startEditing = (): void => {
    setDraft(section.body ?? '');
    setError(undefined);
    setEditing(true);
    // The textarea mounts on this same click; the focus waits for the next paint.
    globalThis.setTimeout(() => textareaRef.current?.focus(), 0);
  };

  const empty = section.body === null;
  if (!editing) {
    return <>
      <p className="brand-section__body">{empty ? EMPTY_SECTION : section.body}</p>
      <div className="brand-section__actions">
        {canEdit && <Button size="sm" variant="secondary" aria-label={`${empty ? 'Preencher' : 'Editar'} ${label}`} onClick={startEditing}>{empty ? 'Preencher' : 'Editar'}</Button>}
      </div>
    </>;
  }

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    // The column rejects whitespace-only text (400); the screen refuses it before the request and
    // keeps the draft, so nothing typed is lost.
    if (draft.trim() === '') { setError('Escreva o conteúdo da seção.'); return; }
    save.mutate(draft);
  };

  return <form className="brand-section__editor" onSubmit={onSubmit} noValidate>
    <label className="brand-section__editor-label" htmlFor={`${sectionKey}-${client.id}`}>Editar {label}</label>
    <Textarea
      ref={textareaRef}
      id={`${sectionKey}-${client.id}`}
      name={sectionKey}
      value={draft}
      rows={6}
      onChange={(event) => { setDraft(event.target.value); setError(undefined); }}
    />
    {error !== undefined && <FieldMessage role="alert">{error}</FieldMessage>}
    <div className="brand-section__actions">
      <Button type="submit" size="sm" loading={save.isPending}>Salvar</Button>
      <Button type="button" size="sm" variant="ghost" disabled={save.isPending} onClick={() => { setEditing(false); setError(undefined); }}>Cancelar</Button>
    </div>
  </form>;
}

/** The colors list: swatch, name and hex, up to 24 (the API cap). */
function ColorsSection({ client, colors, canEdit }: { client: ClientDetailResponse; colors: BrandColor[] | null; canEdit: boolean }) {
  const agency = useAgencyContext();
  const httpClient = useApiClient();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<BrandColor[]>([]);
  const [error, setError] = useState<string | undefined>();

  const save = useMutation({
    mutationFn: (next: BrandColor[]) => httpClient.request({
      path: apiPath('/agencies/:agencyId/clients/:clientId/brand-study/sections/:sectionKey', {
        agencyId: agency.agencyId,
        clientId: client.id,
        sectionKey: 'colors'
      }),
      method: 'PUT',
      body: { colors: next },
      response: BrandStudySectionSchema
    }),
    onSuccess: (updated) => {
      setEditing(false);
      setError(undefined);
      queryClient.setQueryData<BrandStudyResponse>(brandStudyQueryKey(agency.agencyId, client.id), (current) =>
        current === undefined ? current : { ...current, sections: current.sections.map((item) => (item.key === 'colors' ? updated : item)) });
      invalidateStudyWrites(queryClient, agency.agencyId, client.id);
    },
    onError: (saveError: unknown) => { setError(sectionMutationError(saveError)); }
  });

  const startEditing = (): void => {
    setDraft(colors === null || colors.length === 0 ? [{ name: '', hex: '' }] : colors.map((color) => ({ ...color })));
    setError(undefined);
    setEditing(true);
  };

  const setColor = (index: number, patch: Partial<BrandColor>): void => {
    setDraft((current) => current.map((color, position) => (position === index ? { ...color, ...patch } : color)));
    setError(undefined);
  };

  if (!editing) {
    const empty = colors === null || colors.length === 0;
    return <>
      {empty
        ? <p className="brand-section__body">{EMPTY_SECTION}</p>
        : <ul className="brand-colors">
          {colors.map((color) => <li key={`${color.name}-${color.hex}`} className="brand-colors__item">
            <span className="brand-colors__swatch" style={{ background: color.hex }} aria-hidden="true" />
            <span>{color.name}</span>
            <span className="brand-colors__hex">{color.hex}</span>
          </li>)}
        </ul>}
      <div className="brand-section__actions">
        {canEdit && <Button size="sm" variant="secondary" aria-label={`${empty ? 'Preencher' : 'Editar'} Cores`} onClick={startEditing}>{empty ? 'Preencher' : 'Editar'}</Button>}
      </div>
    </>;
  }

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const filled = draft.filter((color) => color.name.trim() !== '' || color.hex.trim() !== '');
    // Removing every row is clearing the section: the contract accepts `colors: []` and the API
    // reads it as not filled, so the last removal travels instead of getting stuck (review of #388).
    if (filled.length === 0) { save.mutate([]); return; }
    if (filled.some((color) => color.name.trim() === '' || !HEX_PATTERN.test(color.hex.trim()))) { setError(COLORS_INVALID); return; }
    const normalized = filled.map((color) => ({ name: color.name.trim(), hex: color.hex.trim() }));
    save.mutate(normalized);
  };

  return <form className="brand-section__editor" onSubmit={onSubmit} noValidate>
    <ul className="brand-colors brand-colors--edit">
      {draft.map((color, index) => <li key={index} className="brand-colors__row">
        <TextInput
          aria-label={`Nome da cor ${index + 1}`}
          placeholder="Nome"
          value={color.name}
          onChange={(event) => setColor(index, { name: event.target.value })}
        />
        <TextInput
          aria-label={`Código da cor ${index + 1}`}
          placeholder="#7A1F2B"
          value={color.hex}
          onChange={(event) => setColor(index, { hex: event.target.value })}
        />
        <Button
          type="button"
          size="sm"
          variant="ghost"
          aria-label={`Remover a cor ${index + 1}`}
          onClick={() => { setDraft((current) => current.filter((_color, position) => position !== index)); setError(undefined); }}
        >Remover</Button>
      </li>)}
    </ul>
    <div className="brand-section__actions">
      <Button type="button" size="sm" variant="secondary" disabled={draft.length >= 24} onClick={() => { setDraft((current) => [...current, { name: '', hex: '' }]); setError(undefined); }}>Adicionar cor</Button>
    </div>
    {error !== undefined && <FieldMessage role="alert">{error}</FieldMessage>}
    <div className="brand-section__actions">
      <Button type="submit" size="sm" loading={save.isPending}>Salvar</Button>
      <Button type="button" size="sm" variant="ghost" disabled={save.isPending} onClick={() => { setEditing(false); setError(undefined); }}>Cancelar</Button>
    </div>
  </form>;
}

/** The archetype: one of the twelve, chosen by the Portuguese label. */
function ArchetypeSection({ client, archetype, canEdit }: { client: ClientDetailResponse; archetype: string | null; canEdit: boolean }) {
  const agency = useAgencyContext();
  const httpClient = useApiClient();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | undefined>();

  const save = useMutation({
    mutationFn: (next: string) => httpClient.request({
      path: apiPath('/agencies/:agencyId/clients/:clientId/brand-study/sections/:sectionKey', {
        agencyId: agency.agencyId,
        clientId: client.id,
        sectionKey: 'archetype'
      }),
      method: 'PUT',
      body: { archetype: next },
      response: BrandStudySectionSchema
    }),
    onSuccess: (updated) => {
      setEditing(false);
      setError(undefined);
      queryClient.setQueryData<BrandStudyResponse>(brandStudyQueryKey(agency.agencyId, client.id), (current) =>
        current === undefined ? current : { ...current, sections: current.sections.map((item) => (item.key === 'archetype' ? updated : item)) });
      invalidateStudyWrites(queryClient, agency.agencyId, client.id);
    },
    onError: (saveError: unknown) => { setError(sectionMutationError(saveError)); }
  });

  const label = archetype === null ? null : ARCHETYPE_LABELS[archetype as keyof typeof ARCHETYPE_LABELS];
  if (!editing) {
    return <>
      <p className="brand-section__body">{label ?? EMPTY_SECTION}</p>
      <div className="brand-section__actions">
        {canEdit && <Button size="sm" variant="secondary" aria-label={`${label === null ? 'Preencher' : 'Editar'} Arquétipo`} onClick={() => { setDraft(archetype ?? ''); setError(undefined); setEditing(true); }}>{label === null ? 'Preencher' : 'Editar'}</Button>}
      </div>
    </>;
  }

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (draft === '') { setError('Escolha um arquétipo da lista.'); return; }
    save.mutate(draft);
  };

  return <form className="brand-section__editor" onSubmit={onSubmit} noValidate>
    <Select
      label="Arquétipo"
      value={draft}
      placeholder="Selecione"
      options={ARCHETYPE_OPTIONS}
      onChange={(value) => { setDraft(value); setError(undefined); }}
    />
    {error !== undefined && <FieldMessage role="alert">{error}</FieldMessage>}
    <div className="brand-section__actions">
      <Button type="submit" size="sm" loading={save.isPending}>Salvar</Button>
      <Button type="button" size="sm" variant="ghost" disabled={save.isPending} onClick={() => { setEditing(false); setError(undefined); }}>Cancelar</Button>
    </div>
  </form>;
}

interface PersonaDraft {
  readonly name: string;
  readonly description: string;
  readonly pains: string;
  readonly desires: string;
  readonly objections: string;
}

const draftFromPersona = (persona: Persona): PersonaDraft => ({
  name: persona.name,
  description: persona.description ?? '',
  pains: persona.pains ?? '',
  desires: persona.desires ?? '',
  objections: persona.objections ?? ''
});

const emptyDraft: PersonaDraft = { name: '', description: '', pains: '', desires: '', objections: '' };

/** The persona form fields, shared by the create modal and the in-place edit of the detail modal. */
function PersonaFields({ draft, onChange, nameRef, nameError }: {
  draft: PersonaDraft;
  onChange: (patch: Partial<PersonaDraft>) => void;
  nameRef?: Ref<HTMLInputElement>;
  nameError?: string;
}) {
  const nameId = useId();
  const nameErrorId = useId();
  return <>
    <div className="form-field">
      <label htmlFor={nameId}>Nome</label>
      <TextInput
        ref={nameRef}
        id={nameId}
        name="name"
        value={draft.name}
        onChange={(event) => onChange({ name: event.target.value })}
        aria-invalid={nameError !== undefined}
        aria-describedby={nameError === undefined ? undefined : nameErrorId}
      />
      {nameError !== undefined && <FieldMessage id={nameErrorId} role="alert">{nameError}</FieldMessage>}
    </div>
    {([['description', 'Descrição'], ['pains', 'Dores'], ['desires', 'Desejos'], ['objections', 'Objeções']] as const).map(([field, label]) => (
      <div key={field} className="form-field">
        <label htmlFor={`${field}-${nameId}`}>{label}</label>
        <Textarea
          id={`${field}-${nameId}`}
          name={field}
          rows={3}
          value={draft[field]}
          onChange={(event) => onChange({ [field]: event.target.value })}
        />
      </div>
    ))}
  </>;
}

/** The `PATCH` body: only what changed; a cleared field travels as `null` (review lessons of #379). */
const personaChanges = (persona: Persona, draft: PersonaDraft): Record<string, string | null> => {
  const body: Record<string, string | null> = {};
  const name = draft.name.trim();
  if (name !== persona.name) body.name = name;
  for (const field of ['description', 'pains', 'desires', 'objections'] as const) {
    const value = draft[field].trim();
    if (value !== (persona[field] ?? '')) body[field] = value === '' ? null : value;
  }
  return body;
};

function CreatePersonaDialog({ client, onClose }: { client: ClientDetailResponse; onClose: () => void }) {
  const agency = useAgencyContext();
  const httpClient = useApiClient();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<PersonaDraft>(emptyDraft);
  const [nameError, setNameError] = useState<string | undefined>();
  const [formError, setFormError] = useState<string | undefined>();
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => { nameRef.current?.focus(); }, []);

  const create = useMutation({
    mutationFn: () => httpClient.request({
      path: apiPath('/agencies/:agencyId/clients/:clientId/personas', { agencyId: agency.agencyId, clientId: client.id }),
      method: 'POST',
      body: {
        name: draft.name.trim(),
        description: draft.description.trim() === '' ? null : draft.description,
        pains: draft.pains.trim() === '' ? null : draft.pains,
        desires: draft.desires.trim() === '' ? null : draft.desires,
        objections: draft.objections.trim() === '' ? null : draft.objections
      },
      response: PersonaSchema
    }),
    onSuccess: () => {
      invalidateStudyWrites(queryClient, agency.agencyId, client.id);
      onClose();
    },
    onError: (error: unknown) => {
      if (error instanceof HttpClientError && error.status === 400 && refusedName(error.details)) { setNameError(NAME_INVALID); return; }
      if (error instanceof HttpClientError && (error.code === 'FORBIDDEN' || error.status === 403)) { setFormError(NO_PERMISSION); return; }
      if (error instanceof HttpClientError && error.code === 'CLIENT_ARCHIVED') { setFormError(ARCHIVED_READ_ONLY); return; }
      setFormError(SAVE_FAILED);
    }
  });

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const name = draft.name.trim();
    if (name === '') { setNameError(NAME_REQUIRED); return; }
    // The schema's byte cap would otherwise surface as the generic invalid-characters message.
    if (utf8ByteLength(name) > PERSONA_NAME_MAX_BYTES) { setNameError(NAME_TOO_LONG); return; }
    if (!PersonaNameSchema.safeParse(name).success) { setNameError(NAME_INVALID); return; }
    create.mutate();
  };

  return <Modal title="Nova persona" closeLabel="Fechar nova persona" onClose={onClose}>
    <form className="form-stack" onSubmit={onSubmit} noValidate>
      <PersonaFields
        draft={draft}
        nameRef={nameRef}
        nameError={nameError}
        onChange={(patch) => { setDraft((current) => ({ ...current, ...patch })); setNameError(undefined); setFormError(undefined); }}
      />
      {formError !== undefined && <FieldMessage role="alert">{formError}</FieldMessage>}
      <div className="form-actions">
        <Button type="submit" loading={create.isPending}>Criar persona</Button>
      </div>
    </form>
  </Modal>;
}

/** The persona detail: read the four fields, edit in place, archive with confirmation. */
function PersonaDialog({ client, persona, onClose }: { client: ClientDetailResponse; persona: Persona; onClose: () => void }) {
  const agency = useAgencyContext();
  const httpClient = useApiClient();
  const queryClient = useQueryClient();
  const canOperate = useCan('cliente.operar');
  const canEdit = canOperate && client.status === 'active';
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<PersonaDraft>(() => draftFromPersona(persona));
  const [nameError, setNameError] = useState<string | undefined>();
  const [formError, setFormError] = useState<string | undefined>();
  const [confirmingArchive, setConfirmingArchive] = useState(false);

  const save = useMutation({
    mutationFn: (body: Record<string, string | null>) => httpClient.request({
      path: apiPath('/agencies/:agencyId/clients/:clientId/personas/:personaId', {
        agencyId: agency.agencyId,
        clientId: client.id,
        personaId: persona.id
      }),
      method: 'PATCH',
      body,
      response: PersonaSchema
    }),
    onSuccess: () => {
      setEditing(false);
      setFormError(undefined);
      invalidateStudyWrites(queryClient, agency.agencyId, client.id);
      onClose();
    },
    onError: (error: unknown) => {
      if (error instanceof HttpClientError && error.status === 400 && refusedName(error.details)) { setNameError(NAME_INVALID); return; }
      if (error instanceof HttpClientError && (error.code === 'FORBIDDEN' || error.status === 403)) { setFormError(NO_PERMISSION); return; }
      if (error instanceof HttpClientError && error.code === 'CLIENT_ARCHIVED') { setFormError(ARCHIVED_READ_ONLY); return; }
      setFormError(SAVE_FAILED);
    }
  });

  const archive = useMutation({
    mutationFn: () => httpClient.request({
      path: apiPath('/agencies/:agencyId/clients/:clientId/personas/:personaId/archive', {
        agencyId: agency.agencyId,
        clientId: client.id,
        personaId: persona.id
      }),
      method: 'POST',
      response: PersonaSchema
    }),
    onSuccess: () => {
      setConfirmingArchive(false);
      invalidateStudyWrites(queryClient, agency.agencyId, client.id);
      onClose();
    },
    onError: (error: unknown) => {
      setConfirmingArchive(false);
      setFormError(sectionMutationError(error));
    }
  });

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const name = draft.name.trim();
    if (name === '') { setNameError(NAME_REQUIRED); return; }
    if (utf8ByteLength(name) > PERSONA_NAME_MAX_BYTES) { setNameError(NAME_TOO_LONG); return; }
    if (!PersonaNameSchema.safeParse(name).success) { setNameError(NAME_INVALID); return; }
    const body = personaChanges(persona, draft);
    if (Object.keys(body).length === 0) { setEditing(false); return; }
    save.mutate(body);
  };

  return <Modal title={persona.name} closeLabel="Fechar persona" onClose={onClose}>
    {editing
      ? <form className="form-stack" onSubmit={onSubmit} noValidate>
        <PersonaFields
          draft={draft}
          nameError={nameError}
          onChange={(patch) => { setDraft((current) => ({ ...current, ...patch })); setNameError(undefined); setFormError(undefined); }}
        />
        {formError !== undefined && <FieldMessage role="alert">{formError}</FieldMessage>}
        <div className="form-actions">
          <Button type="submit" loading={save.isPending}>Salvar</Button>
          <Button type="button" variant="ghost" disabled={save.isPending} onClick={() => { setEditing(false); setDraft(draftFromPersona(persona)); setFormError(undefined); setNameError(undefined); }}>Cancelar</Button>
        </div>
      </form>
      : <>
        <dl className="brand-persona__fields">
          <dt>Descrição</dt><dd>{persona.description ?? NOT_INFORMED}</dd>
          <dt>Dores</dt><dd>{persona.pains ?? NOT_INFORMED}</dd>
          <dt>Desejos</dt><dd>{persona.desires ?? NOT_INFORMED}</dd>
          <dt>Objeções</dt><dd>{persona.objections ?? NOT_INFORMED}</dd>
        </dl>
        <StudyConversation client={client} subject={{ personaId: persona.id }} subjectLabel={persona.name} readOnly={persona.status === 'archived'} headingLevel={3} />
        {formError !== undefined && <FieldMessage role="alert">{formError}</FieldMessage>}
        {canEdit && <div className="brand-persona__actions">
          <Button size="sm" variant="secondary" onClick={() => { setDraft(draftFromPersona(persona)); setEditing(true); setNameError(undefined); }}>Editar</Button>
          <Button size="sm" variant="secondary" onClick={() => { setFormError(undefined); setConfirmingArchive(true); }}>Arquivar</Button>
        </div>}
        <ConfirmDialog
          open={confirmingArchive}
          title={`Arquivar ${persona.name}?`}
          description={PERSONA_ARCHIVE_DESCRIPTION}
          confirmLabel="Arquivar"
          cancelLabel="Cancelar"
          busy={archive.isPending}
          onConfirm={() => archive.mutate()}
          onCancel={() => { if (!archive.isPending) setConfirmingArchive(false); }}
        />
      </>}
  </Modal>;
}

/** The personas block: active cards, create, and the collapsed archived list with Desarquivar. */
function PersonasSection({ client, personas, canEdit }: { client: ClientDetailResponse; personas: Persona[]; canEdit: boolean }) {
  const agency = useAgencyContext();
  const httpClient = useApiClient();
  const queryClient = useQueryClient();
  const [openPersona, setOpenPersona] = useState<Persona | null>(null);
  const [creating, setCreating] = useState(false);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const unarchive = useMutation({
    mutationFn: (personaId: string) => httpClient.request({
      path: apiPath('/agencies/:agencyId/clients/:clientId/personas/:personaId/unarchive', {
        agencyId: agency.agencyId,
        clientId: client.id,
        personaId
      }),
      method: 'POST',
      response: PersonaSchema
    }),
    onSuccess: () => {
      setError(undefined);
      invalidateStudyWrites(queryClient, agency.agencyId, client.id);
    },
    onError: (archiveError: unknown) => { setError(sectionMutationError(archiveError)); }
  });

  const active = personas.filter((persona) => persona.status === 'active');
  const archived = personas.filter((persona) => persona.status === 'archived');
  // The open modal reads the persona from the refetched list, so it never shows a stale copy.
  const currentOpen = openPersona === null ? null : personas.find((persona) => persona.id === openPersona.id) ?? null;

  return <div className="brand-personas">
    {canEdit && <div className="brand-personas__header">
      <Button size="sm" variant="secondary" aria-label="Adicionar persona" onClick={() => setCreating(true)}><span aria-hidden="true">+</span> persona</Button>
    </div>}

    {active.length === 0
      ? <p className="brand-section__body">Nenhuma persona ainda</p>
      : <ul className="brand-personas__list">
        {active.map((persona) => <li key={persona.id}>
          <button type="button" className="brand-personas__card" onClick={() => setOpenPersona(persona)}>
            <span className="brand-personas__name">{persona.name}</span>
            {persona.description !== null && <span className="brand-personas__description">{persona.description}</span>}
          </button>
        </li>)}
      </ul>}

    {archived.length > 0 && (archivedOpen
      ? <section className="brand-personas__archived" aria-label="Personas arquivadas">
        <header className="brand-personas__header">
          <h4 className="brand-personas__archived-title">{`Arquivadas (${archived.length})`}</h4>
          <Button size="sm" variant="ghost" onClick={() => setArchivedOpen(false)}>Ocultar</Button>
        </header>
        <ul className="brand-personas__list">
          {archived.map((persona) => <li key={persona.id} className="brand-personas__archived-item">
            <span className="brand-personas__name">{persona.name}</span>
            {canEdit && <Button
              size="sm"
              variant="secondary"
              aria-label={`Desarquivar ${persona.name}`}
              loading={unarchive.isPending && unarchive.variables === persona.id}
              onClick={() => unarchive.mutate(persona.id)}
            >Desarquivar</Button>}
          </li>)}
        </ul>
      </section>
      : <Button variant="ghost" aria-expanded={archivedOpen} onClick={() => setArchivedOpen(true)}>{`Arquivadas (${archived.length})`} <span aria-hidden="true">▾</span></Button>)}

    <StudyConversation client={client} subject={{ sectionKey: 'personas' }} subjectLabel={SECTION_LABELS.personas} readOnly={false} />
    {error !== undefined && <FieldMessage role="alert">{error}</FieldMessage>}

    {currentOpen !== null && <PersonaDialog client={client} persona={currentOpen} onClose={() => setOpenPersona(null)} />}
    {creating && <CreatePersonaDialog client={client} onClose={() => setCreating(false)} />}
  </div>;
}

/**
 * The brand-study tab (`specs/clientes.md` §7, issue #138): the seven fixed sections, always in the
 * same order and always present, with in-place editing for `cliente.operar` on an active client.
 * Every edit invalidates the study and the client detail, so the counter here and the General tab
 * move together without a reload. The conversations of each section and persona are #142.
 */
export function ClientBrandStudyTab() {
  const agency = useAgencyContext();
  const httpClient = useApiClient();
  const client = useClientDetail();
  const canOperate = useCan('cliente.operar');
  const canEdit = canOperate && client.status === 'active';

  const study = useQuery({
    queryKey: brandStudyQueryKey(agency.agencyId, client.id),
    queryFn: ({ signal }) => httpClient.request({
      path: apiPath('/agencies/:agencyId/clients/:clientId/brand-study', { agencyId: agency.agencyId, clientId: client.id }),
      response: BrandStudyResponseSchema,
      signal
    })
  });

  if (study.isPending) {
    return <div className="brand-study" aria-busy="true">
      {SECTION_ORDER.map((key) => <Skeleton key={key} className="brand-section-skeleton" />)}
    </div>;
  }

  if (study.isError && study.data === undefined) {
    return <div className="brand-study__error" role="alert">
      <p>{LOAD_FAILED}</p>
      <Button onClick={() => { void study.refetch(); }} loading={study.isFetching}>Tentar de novo</Button>
    </div>;
  }

  const data = study.data;
  if (data === undefined) return null;
  const sectionOf = (key: SectionKey) => data.sections.find((section) => section.key === key);

  return <div className="brand-study">
    <header className="brand-study__header">
      <h2>Estudo de marca</h2>
      <p className="brand-study__count">{data.filled} de 7 preenchidas</p>
    </header>

    {SECTION_ORDER.map((key) => {
      const section = sectionOf(key);
      if (key === 'personas') {
        return <div key={key} className="brand-section">
          <header className="brand-section__header"><h3>{SECTION_LABELS.personas}</h3></header>
          <PersonasSection client={client} personas={data.personas} canEdit={canEdit} />
        </div>;
      }
      const header = <header className="brand-section__header">
        <h3>{SECTION_LABELS[key]}</h3>
        {section !== undefined && <UpdatedBy section={section} />}
      </header>;
      if (key === 'colors') {
        return <div key={key} className="brand-section">
          {header}
          <ColorsSection client={client} colors={section?.colors ?? null} canEdit={canEdit} />
          <StudyConversation client={client} subject={{ sectionKey: key }} subjectLabel={SECTION_LABELS[key]} readOnly={false} />
        </div>;
      }
      if (key === 'archetype') {
        return <div key={key} className="brand-section">
          {header}
          <ArchetypeSection client={client} archetype={section?.archetype ?? null} canEdit={canEdit} />
          <StudyConversation client={client} subject={{ sectionKey: key }} subjectLabel={SECTION_LABELS[key]} readOnly={false} />
        </div>;
      }
      return <div key={key} className="brand-section">
        {header}
        <TextSection client={client} sectionKey={key} section={section ?? { body: null }} canEdit={canEdit} />
        <StudyConversation client={client} subject={{ sectionKey: key }} subjectLabel={SECTION_LABELS[key]} readOnly={false} />
      </div>;
    })}
  </div>;
}
