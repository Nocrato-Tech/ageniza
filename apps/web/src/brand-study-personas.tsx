import { useEffect, useRef, useState, type FormEvent, type Ref } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Archive, ArrowLeft, ChevronDown, ChevronRight, Clock, Frown, Heart, MessageCircleWarning, Pencil, Plus } from 'lucide-react';
import { Link, useLocation, useNavigate } from 'react-router-dom';

import {
  PersonaNameSchema,
  PersonaSchema,
  utf8ByteLength,
  type ClientDetailResponse,
  type Persona
} from '@ageniza/contracts';
import { Avatar, Button, ConfirmDialog, EmptyState, Field, FieldMessage, Modal, Pill, Textarea, TextInput, useFormErrors } from '@ageniza/ui';

import { useAgencyContext, useWriteBlocked } from './agency.js';
import { apiPath } from './api-path.js';
import { StudyConversation, type AwaitingCounts } from './brand-study-conversation.js';
import {
  ARCHIVED_READ_ONLY,
  invalidateStudyWrites,
  NO_PERMISSION,
  NOT_INFORMED,
  personaSearch,
  refusedName,
  SAVE_FAILED,
  SECTION_LABELS,
  sectionMutationError,
  sectionSearch
} from './brand-study-model.js';
import { PanelLayout } from './brand-study-sections.js';
import { HttpClientError, useApiClient } from './http.js';

const NAME_REQUIRED = 'Informe o nome da persona.';
const NAME_INVALID = 'O nome contém caracteres que não são aceitos.';
const NAME_TOO_LONG = 'O nome da persona pode ter no máximo 120 bytes.';
const PERSONA_ARCHIVE_DESCRIPTION = 'Ela some do portal e as conversas dela ficam somente leitura. Você pode desarquivar depois.';
const PERSONA_NAME_MAX_BYTES = 120;

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

/** The persona form fields, shared by the create modal and the in-place edit of the profile. */
function PersonaFields({ draft, onChange, nameRef, nameError }: {
  draft: PersonaDraft;
  onChange: (patch: Partial<PersonaDraft>) => void;
  nameRef?: Ref<HTMLInputElement>;
  nameError?: string;
}) {
  return <>
    <Field label="Nome" error={nameError}>
      {(control) => <TextInput ref={nameRef} {...control} name="name" value={draft.name} onChange={(event) => onChange({ name: event.target.value })} />}
    </Field>
    {([['description', 'Descrição'], ['pains', 'Dores'], ['desires', 'Desejos'], ['objections', 'Objeções']] as const).map(([field, label]) => (
      <Field key={field} label={label}>
        {(control) => <Textarea {...control} name={field} rows={3} value={draft[field]} onChange={(event) => onChange({ [field]: event.target.value })} />}
      </Field>
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

/** The name rules the screen checks before the request, so the API's byte cap never surfaces as "invalid characters". */
const nameProblem = (rawName: string): string | undefined => {
  const name = rawName.trim();
  if (name === '') return NAME_REQUIRED;
  if (utf8ByteLength(name) > PERSONA_NAME_MAX_BYTES) return NAME_TOO_LONG;
  if (!PersonaNameSchema.safeParse(name).success) return NAME_INVALID;
  return undefined;
};

const personaWriteError = (error: unknown): { field?: string; form?: string } => {
  if (error instanceof HttpClientError && error.status === 400 && refusedName(error.details)) return { field: NAME_INVALID };
  if (error instanceof HttpClientError && (error.code === 'FORBIDDEN' || error.status === 403)) return { form: NO_PERMISSION };
  if (error instanceof HttpClientError && error.code === 'CLIENT_ARCHIVED') return { form: ARCHIVED_READ_ONLY };
  return { form: SAVE_FAILED };
};

function CreatePersonaDialog({ client, onClose }: { client: ClientDetailResponse; onClose: () => void }) {
  const agency = useAgencyContext();
  const httpClient = useApiClient();
  const { formRef, summary } = useFormErrors();
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
      const problem = personaWriteError(error);
      setNameError(problem.field);
      setFormError(problem.form);
    }
  });

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const problem = nameProblem(draft.name);
    if (problem !== undefined) { setNameError(problem); return; }
    create.mutate();
  };

  return <Modal title="Nova persona" closeLabel="Fechar nova persona" onClose={onClose}>
    <form ref={formRef} className="form-stack" onSubmit={onSubmit} noValidate>
      {summary}
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

const AwaitingPill = ({ count }: { count: number | undefined }) =>
  count === undefined || count === 0 ? null : <Pill icon={<Clock />} className="brand-personas__awaiting">{count} aguardando</Pill>;

/** The three long fields of a persona, each in a card of its own with the icon that names it. */
const PROFILE_CARDS = [
  ['pains', 'Dores', Frown],
  ['desires', 'Desejos', Heart],
  ['objections', 'Objeções', MessageCircleWarning]
] as const;

/**
 * The profile of one persona: identity on the left, pains, desires and objections in cards, then the persona's
 * conversations. Editing swaps the cards for the form; archiving asks first and goes back to the grid.
 */
function PersonaProfile({ client, persona, canEdit, backState, headingRef, draft, onDraft }: {
  client: ClientDetailResponse;
  persona: Persona;
  canEdit: boolean;
  backState: unknown;
  headingRef: Ref<HTMLHeadingElement>;
  /** The edit in progress, kept by the section so it outlives the profile when the person goes to another part of the study. */
  draft: PersonaDraft | null;
  onDraft: (update: (current: PersonaDraft | null) => PersonaDraft | null) => void;
}) {
  const blocked = useWriteBlocked();
  const agency = useAgencyContext();
  const httpClient = useApiClient();
  const { formRef, summary } = useFormErrors();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const archived = persona.status === 'archived';
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
      onDraft(() => null);
      setFormError(undefined);
      invalidateStudyWrites(queryClient, agency.agencyId, client.id);
    },
    onError: (error: unknown) => {
      const problem = personaWriteError(error);
      setNameError(problem.field);
      setFormError(problem.form);
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
      void navigate({ search: sectionSearch('personas') }, { replace: true, state: backState });
    },
    onError: (error: unknown) => {
      setConfirmingArchive(false);
      setFormError(sectionMutationError(error));
    }
  });

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (draft === null) return;
    const problem = nameProblem(draft.name);
    if (problem !== undefined) { setNameError(problem); return; }
    const body = personaChanges(persona, draft);
    if (Object.keys(body).length === 0) { onDraft(() => null); return; }
    save.mutate(body);
  };

  const back = <Link className="brand-persona__back" to={{ search: sectionSearch('personas') }} state={backState} aria-label={`Voltar para ${SECTION_LABELS.personas}`}>
    <ArrowLeft aria-hidden="true" />
    {SECTION_LABELS.personas}
  </Link>;

  const editing = draft !== null && canEdit && !archived && blocked === undefined;

  // A draft kept while the persona was left can outlive the right to edit her (archived, client archived, plan or permission lost).
  useEffect(() => {
    if (draft !== null && !editing) onDraft(() => null);
  }, [draft, editing, onDraft]);

  if (draft !== null && editing) {
    return <div className="brand-persona">
      {back}
      <h3 ref={headingRef} tabIndex={-1} className="brand-persona__name">{persona.name}</h3>
      <form ref={formRef} className="form-stack brand-persona__form" onSubmit={onSubmit} noValidate>
        {summary}
        <PersonaFields
          draft={draft}
          nameError={nameError}
          onChange={(patch) => { onDraft((current) => (current === null ? current : { ...current, ...patch })); setNameError(undefined); setFormError(undefined); }}
        />
        {formError !== undefined && <FieldMessage role="alert">{formError}</FieldMessage>}
        <div className="form-actions">
          <Button type="submit" loading={save.isPending}>Salvar</Button>
          <Button type="button" variant="ghost" disabled={save.isPending} onClick={() => { onDraft(() => null); setFormError(undefined); setNameError(undefined); }}>Cancelar</Button>
        </div>
      </form>
    </div>;
  }

  return <div className="brand-persona">
    {back}
    <div className="brand-persona__profile">
      <div className="brand-persona__identity">
        <Avatar name={persona.name} size="lg" className="brand-persona__avatar" />
        <h3 ref={headingRef} tabIndex={-1} className="brand-persona__name">{persona.name}</h3>
        {archived && <Pill>Arquivada</Pill>}
        <p className="brand-persona__description">{persona.description ?? NOT_INFORMED}</p>
        {canEdit && !archived && <div className="brand-persona__actions">
          <Button size="sm" variant="secondary" leadingIcon={<Pencil />} blockedReason={blocked} onClick={() => { onDraft(() => draftFromPersona(persona)); setNameError(undefined); }}>Editar</Button>
          <Button size="sm" variant="ghost" leadingIcon={<Archive />} blockedReason={blocked} onClick={() => { setFormError(undefined); setConfirmingArchive(true); }}>Arquivar</Button>
        </div>}
        {formError !== undefined && <FieldMessage role="alert">{formError}</FieldMessage>}
      </div>
      <div className="brand-persona__content">
        {PROFILE_CARDS.map(([field, label, FieldIcon]) => <article key={field} className="brand-persona__card">
          <span className="brand-persona__card-icon" aria-hidden="true"><FieldIcon /></span>
          <h4>{label}</h4>
          <p className="brand-section__body">{persona[field] ?? NOT_INFORMED}</p>
        </article>)}
        <div className="brand-persona__conversations">
          <StudyConversation client={client} subject={{ personaId: persona.id }} subjectLabel={persona.name} readOnly={archived} headingLevel={4} />
        </div>
      </div>
    </div>
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
  </div>;
}

/**
 * The personas section: a grid of the active ones with the way to add another, the collapsed archived list
 * with Desarquivar, and the profile of one persona when the address names it.
 */
export function PersonasSection({ client, personas, canEdit, active, selectedId, awaiting }: {
  client: ClientDetailResponse;
  personas: Persona[];
  canEdit: boolean;
  /** This section is the one on screen: only then does the focus follow an open or a return. */
  active: boolean;
  selectedId: string | null;
  awaiting: AwaitingCounts;
}) {
  const blocked = useWriteBlocked();
  const agency = useAgencyContext();
  const httpClient = useApiClient();
  const queryClient = useQueryClient();
  const location = useLocation();
  const [creating, setCreating] = useState(false);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [drafts, setDrafts] = useState<ReadonlyMap<string, PersonaDraft>>(() => new Map());
  const [error, setError] = useState<string | undefined>();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const previousSelected = useRef(selectedId);

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

  // Opening a profile puts the focus on its name; coming back puts it on the card just left, so the keyboard keeps its place.
  useEffect(() => {
    const before = previousSelected.current;
    previousSelected.current = selectedId;
    if (!active || before === selectedId) return;
    if (selectedId !== null) { headingRef.current?.focus(); return; }
    const card = before === null ? null : gridRef.current?.querySelector<HTMLElement>(`[data-persona-id="${before}"]`);
    card?.focus();
  }, [active, selectedId]);

  const activePersonas = personas.filter((persona) => persona.status === 'active');
  const archivedPersonas = personas.filter((persona) => persona.status === 'archived');
  const selected = selectedId === null ? null : personas.find((persona) => persona.id === selectedId) ?? null;

  const newPersona = <Button size="sm" variant="secondary" leadingIcon={<Plus />} blockedReason={blocked} onClick={() => setCreating(true)}>Nova persona</Button>;
  const createDialog = creating && <CreatePersonaDialog client={client} onClose={() => setCreating(false)} />;

  if (selected !== null) {
    const personaId = selected.id;
    const onDraft = (update: (current: PersonaDraft | null) => PersonaDraft | null): void => {
      setDrafts((current) => {
        const next = update(current.get(personaId) ?? null);
        const copy = new Map(current);
        if (next === null) copy.delete(personaId); else copy.set(personaId, next);
        return copy;
      });
    };
    return <PersonaProfile key={personaId} client={client} persona={selected} canEdit={canEdit} backState={location.state} headingRef={headingRef} draft={drafts.get(personaId) ?? null} onDraft={onDraft} />;
  }

  return <PanelLayout conversation={active ? <StudyConversation client={client} subject={{ sectionKey: 'personas' }} subjectLabel={SECTION_LABELS.personas} readOnly={false} /> : null}>
    <div className="brand-personas" ref={gridRef}>
      <header className="brand-personas__header">
        <h3>{SECTION_LABELS.personas}</h3>
        {canEdit && activePersonas.length > 0 && newPersona}
      </header>
      {activePersonas.length === 0
        ? <EmptyState
          className="brand-section__empty"
          headingLevel={4}
          title="Nenhuma persona ainda"
          description={canEdit ? 'Descreva para quem a marca fala: dores, desejos e objeções.' : undefined}
          action={canEdit ? newPersona : undefined}
        />
        : <ul className="brand-personas__list">
          {activePersonas.map((persona) => <li key={persona.id}>
            <Link className="brand-personas__card" data-persona-id={persona.id} to={{ search: personaSearch(persona.id) }} state={location.state}>
              <Avatar name={persona.name} size="lg" />
              <span className="brand-personas__body">
                <span className="brand-personas__name">{persona.name}</span>
                {persona.description !== null && <span className="brand-personas__description">{persona.description}</span>}
                <AwaitingPill count={awaiting.persona[persona.id]} />
              </span>
              <ChevronRight className="brand-personas__go" aria-hidden="true" />
            </Link>
          </li>)}
        </ul>}

      {archivedPersonas.length > 0 && (archivedOpen
        ? <section className="brand-personas__archived" aria-label="Personas arquivadas">
          <header className="brand-personas__header">
            <h4 className="brand-personas__archived-title">{`Arquivadas (${archivedPersonas.length})`}</h4>
            <Button size="sm" variant="ghost" onClick={() => setArchivedOpen(false)}>Ocultar</Button>
          </header>
          <ul className="brand-personas__list">
            {archivedPersonas.map((persona) => <li key={persona.id} className="brand-personas__archived-item">
              <Link className="brand-personas__name" to={{ search: personaSearch(persona.id) }} state={location.state}>{persona.name}</Link>
              {canEdit && <Button
                size="sm"
                variant="secondary"
                aria-label={`Desarquivar ${persona.name}`}
                blockedReason={blocked}
                loading={unarchive.isPending && unarchive.variables === persona.id}
                onClick={() => unarchive.mutate(persona.id)}
              >Desarquivar</Button>}
            </li>)}
          </ul>
        </section>
        : <Button variant="ghost" aria-expanded={archivedOpen} trailingIcon={<ChevronDown />} onClick={() => setArchivedOpen(true)}>{`Arquivadas (${archivedPersonas.length})`}</Button>)}

      {error !== undefined && <FieldMessage role="alert">{error}</FieldMessage>}
      {createDialog}
    </div>
  </PanelLayout>;
}
