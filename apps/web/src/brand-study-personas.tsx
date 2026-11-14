import { useEffect, useRef, useState, type FormEvent, type ReactNode, type Ref } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ChevronRight, Clock, Frown, Heart, MapPin, MessageCircleWarning, Mic, Pencil, Plus, Trash2 } from 'lucide-react';
import { Link, useLocation, useNavigate } from 'react-router-dom';

import {
  AuthNoContentResponseSchema,
  PERSONA_TRAIT_MAX_LENGTH,
  PERSONA_TRAITS_MAX,
  PersonaAgeSchema,
  PersonaNameSchema,
  PersonaSchema,
  PersonaTraitsSchema,
  utf8ByteLength,
  type ClientDetailResponse,
  type Persona
} from '@ageniza/contracts';
import { Avatar, Button, ConfirmDialog, EmptyState, Field, FieldMessage, IconButton, Modal, Pill, Stage3D, Textarea, TextInput, Trait, useFormErrors } from '@ageniza/ui';

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
  sectionSearch,
  type SectionKey
} from './brand-study-model.js';
import { PanelLayout } from './brand-study-sections.js';
import { HttpClientError, useApiClient } from './http.js';

const NAME_REQUIRED = 'Informe o nome da persona.';
const NAME_INVALID = 'O nome contém caracteres que não são aceitos.';
const NAME_TOO_LONG = 'O nome da persona pode ter no máximo 120 bytes.';
const PERSONA_GONE = 'Esta persona não existe mais.';
const PERSONA_NAME_MAX_BYTES = 120;

interface PersonaDraft {
  readonly name: string;
  readonly age: string;
  readonly occupation: string;
  readonly location: string;
  /** Comma-separated while typing; the request carries the list. */
  readonly traits: string;
  readonly description: string;
  readonly pains: string;
  readonly desires: string;
  readonly objections: string;
  readonly whereTheyAre: string;
  readonly toneThatWorks: string;
}

const draftFromPersona = (persona: Persona): PersonaDraft => ({
  name: persona.name,
  age: persona.age === null ? '' : String(persona.age),
  occupation: persona.occupation ?? '',
  location: persona.location ?? '',
  traits: persona.traits.join(', '),
  description: persona.description ?? '',
  pains: persona.pains ?? '',
  desires: persona.desires ?? '',
  objections: persona.objections ?? '',
  whereTheyAre: persona.whereTheyAre ?? '',
  toneThatWorks: persona.toneThatWorks ?? ''
});

const emptyDraft: PersonaDraft = {
  name: '', age: '', occupation: '', location: '', traits: '', description: '', pains: '', desires: '', objections: '', whereTheyAre: '', toneThatWorks: ''
};

const AGE_INVALID = 'Informe uma idade entre 1 e 120.';
const TRAITS_INVALID = `Use até ${PERSONA_TRAITS_MAX} traços de até ${PERSONA_TRAIT_MAX_LENGTH} caracteres, separados por vírgula.`;

const parseTraits = (raw: string): string[] => raw.split(',').map((trait) => trait.trim()).filter((trait) => trait !== '');
const parseAge = (raw: string): number | null => (raw.trim() === '' ? null : Number(raw.trim()));

interface ProfileProblems { readonly age?: string; readonly traits?: string }

/** What the screen checks before the request, so the API's refusal never surfaces as a generic failure. */
const profileProblems = (draft: PersonaDraft): ProfileProblems => {
  const age = parseAge(draft.age);
  return {
    ...(age !== null && !PersonaAgeSchema.safeParse(age).success ? { age: AGE_INVALID } : {}),
    ...(!PersonaTraitsSchema.safeParse(parseTraits(draft.traits)).success ? { traits: TRAITS_INVALID } : {})
  };
};

const LONG_FIELDS = [
  ['description', 'Descrição'], ['pains', 'Dores'], ['desires', 'Desejos'], ['objections', 'Objeções'],
  ['whereTheyAre', 'Onde está'], ['toneThatWorks', 'Tom que funciona']
] as const;

/** The persona form fields, shared by the create modal and the in-place edit of the profile. */
function PersonaFields({ draft, onChange, nameRef, nameError, problems }: {
  draft: PersonaDraft;
  onChange: (patch: Partial<PersonaDraft>) => void;
  nameRef?: Ref<HTMLInputElement>;
  nameError?: string;
  problems: ProfileProblems;
}) {
  return <>
    <Field label="Nome" error={nameError}>
      {(control) => <TextInput ref={nameRef} {...control} name="name" value={draft.name} onChange={(event) => onChange({ name: event.target.value })} />}
    </Field>
    <Field label="Idade" error={problems.age}>
      {(control) => <TextInput {...control} name="age" type="number" inputMode="numeric" min={1} max={120} value={draft.age} onChange={(event) => onChange({ age: event.target.value })} />}
    </Field>
    <Field label="Ocupação">
      {(control) => <TextInput {...control} name="occupation" value={draft.occupation} onChange={(event) => onChange({ occupation: event.target.value })} />}
    </Field>
    <Field label="Local">
      {(control) => <TextInput {...control} name="location" value={draft.location} onChange={(event) => onChange({ location: event.target.value })} />}
    </Field>
    <Field label="Traços" hint="Separe por vírgula. Ex.: Rotina corrida, Compra por impulso" error={problems.traits}>
      {(control) => <TextInput {...control} name="traits" value={draft.traits} onChange={(event) => onChange({ traits: event.target.value })} />}
    </Field>
    {LONG_FIELDS.map(([field, label]) => (
      <Field key={field} label={label}>
        {(control) => <Textarea {...control} name={field} rows={3} value={draft[field]} onChange={(event) => onChange({ [field]: event.target.value })} />}
      </Field>
    ))}
  </>;
}

/** The `PATCH` body: only what changed; a cleared field travels as `null` (review lessons of #379). */
const personaChanges = (persona: Persona, draft: PersonaDraft): Record<string, unknown> => {
  const body: Record<string, unknown> = {};
  const name = draft.name.trim();
  if (name !== persona.name) body.name = name;
  for (const field of ['description', 'pains', 'desires', 'objections', 'occupation', 'location', 'whereTheyAre', 'toneThatWorks'] as const) {
    const value = draft[field].trim();
    if (value !== (persona[field] ?? '')) body[field] = value === '' ? null : value;
  }
  const age = parseAge(draft.age);
  if (age !== persona.age) body.age = age;
  const traits = parseTraits(draft.traits);
  if (traits.join('\n') !== persona.traits.join('\n')) body.traits = traits;
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
  const [shown, setShown] = useState<ProfileProblems>({});
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
        objections: draft.objections.trim() === '' ? null : draft.objections,
        age: parseAge(draft.age),
        occupation: draft.occupation.trim() === '' ? null : draft.occupation.trim(),
        location: draft.location.trim() === '' ? null : draft.location.trim(),
        traits: parseTraits(draft.traits),
        whereTheyAre: draft.whereTheyAre.trim() === '' ? null : draft.whereTheyAre.trim(),
        toneThatWorks: draft.toneThatWorks.trim() === '' ? null : draft.toneThatWorks.trim()
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
    const problems = profileProblems(draft);
    setShown(problems);
    if (problem !== undefined) setNameError(problem);
    if (problem !== undefined || Object.keys(problems).length > 0) return;
    create.mutate();
  };

  return <Modal title="Nova persona" closeLabel="Fechar nova persona" onClose={onClose}>
    <form ref={formRef} className="form-stack" onSubmit={onSubmit} noValidate>
      {summary}
      <PersonaFields
        draft={draft}
        nameRef={nameRef}
        nameError={nameError}
        problems={shown}
        onChange={(patch) => { setDraft((current) => ({ ...current, ...patch })); setNameError(undefined); setShown({}); setFormError(undefined); }}
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

/** The rows of the profile column: what the field is called, the icon that names it, and what the pencil says it edits. */
const PROFILE_ROWS = [
  ['pains', 'Dor', Frown, 'a dor'],
  ['desires', 'Desejo', Heart, 'o desejo'],
  ['objections', 'Objeção', MessageCircleWarning, 'a objeção'],
  ['whereTheyAre', 'Onde está', MapPin, 'onde está'],
  ['toneThatWorks', 'Tom que funciona', Mic, 'o tom']
] as const;

/** What the confirmation says goes with the persona: her conversation, by the number of messages the API counted. */
const deleteDescription = (persona: Persona): string => {
  const count = persona.messageCount;
  if (count === 0) return 'Ela ainda não tem mensagens. Não dá para desfazer.';
  return `A conversa dela, com ${count === 1 ? '1 mensagem' : `${count} mensagens`}, também será apagada. Não dá para desfazer.`;
};

/** "34 anos · gerente de RH · Pinheiros": whatever of the three is known. */
const personaRole = (persona: Persona): string => [persona.age === null ? null : `${persona.age} anos`, persona.occupation, persona.location]
  .filter((part): part is string => part !== null && part !== '')
  .join(' · ');

/**
 * The profile of one persona beside the list: who she is, then one row for each field with the pencil that edits it,
 * then the persona's conversations. Editing swaps the column for the form; deleting asks first, says how many messages go with her, and goes back to the list.
 */
function PersonaProfile({ client, persona, canEdit, backState, headingRef, draft, onDraft, list }: {
  client: ClientDetailResponse;
  persona: Persona;
  /** The personas beside the profile, with this one marked. */
  list: ReactNode;
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
  const [nameError, setNameError] = useState<string | undefined>();
  const [formError, setFormError] = useState<string | undefined>();
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [shown, setShown] = useState<ProfileProblems>({});
  const [focusField, setFocusField] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => httpClient.request({
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

  const remove = useMutation({
    mutationFn: () => httpClient.request({
      path: apiPath('/agencies/:agencyId/clients/:clientId/personas/:personaId', {
        agencyId: agency.agencyId,
        clientId: client.id,
        personaId: persona.id
      }),
      method: 'DELETE',
      response: AuthNoContentResponseSchema
    }),
    onSuccess: () => {
      setConfirmingDelete(false);
      invalidateStudyWrites(queryClient, agency.agencyId, client.id);
      void queryClient.invalidateQueries({ queryKey: ['conversation'] });
      void navigate({ search: sectionSearch('personas') }, { replace: true, state: backState });
    },
    onError: (error: unknown) => {
      setConfirmingDelete(false);
      if (error instanceof HttpClientError && error.status === 404) invalidateStudyWrites(queryClient, agency.agencyId, client.id);
      setFormError(error instanceof HttpClientError && error.status === 404 ? PERSONA_GONE : sectionMutationError(error));
    }
  });

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (draft === null) return;
    const problem = nameProblem(draft.name);
    const problems = profileProblems(draft);
    setShown(problems);
    if (problem !== undefined) setNameError(problem);
    if (problem !== undefined || Object.keys(problems).length > 0) return;
    const body = personaChanges(persona, draft);
    if (Object.keys(body).length === 0) { onDraft(() => null); return; }
    save.mutate(body);
  };

  const back = <Link className="brand-persona__back" to={{ search: sectionSearch('personas') }} state={backState} aria-label={`Voltar para ${SECTION_LABELS.personas}`}>
    <ArrowLeft aria-hidden="true" />
    {SECTION_LABELS.personas}
  </Link>;

  const editing = draft !== null && canEdit && blocked === undefined;

  // A draft kept while the persona was left can outlive the right to edit her (client archived, plan or permission lost).
  useEffect(() => {
    if (draft !== null && !editing) onDraft(() => null);
  }, [draft, editing, onDraft]);

  // The pencil of a row opens the form with that field under the cursor.
  const formOpen = draft !== null && editing;
  useEffect(() => {
    if (!formOpen || focusField === null) return;
    formRef.current?.querySelector<HTMLElement>(`[name="${focusField}"]`)?.focus();
    setFocusField(null);
  }, [formOpen, focusField, formRef]);

  if (draft !== null && editing) {
    return <div className="brand-persona">
      {back}
      <h3 ref={headingRef} tabIndex={-1} className="brand-persona__name">{persona.name}</h3>
      <form ref={formRef} className="form-stack brand-persona__form" onSubmit={onSubmit} noValidate>
        {summary}
        <PersonaFields
          draft={draft}
          nameError={nameError}
          problems={shown}
          onChange={(patch) => { onDraft((current) => (current === null ? current : { ...current, ...patch })); setNameError(undefined); setShown({}); setFormError(undefined); }}
        />
        {formError !== undefined && <FieldMessage role="alert">{formError}</FieldMessage>}
        <div className="form-actions">
          <Button type="submit" loading={save.isPending}>Salvar</Button>
          <Button type="button" variant="ghost" disabled={save.isPending} onClick={() => { onDraft(() => null); setFormError(undefined); setNameError(undefined); }}>Cancelar</Button>
        </div>
      </form>
    </div>;
  }

  const startEditing = (field: string | null): void => {
    setFormError(undefined);
    setNameError(undefined);
    setShown({});
    setFocusField(field);
    onDraft(() => draftFromPersona(persona));
  };
  const role = personaRole(persona);

  return <div className="brand-persona">
    {back}
    <div className="brand-persona__split">
      <div className="brand-persona__list">{list}</div>
      <aside className="brand-persona__profile" aria-label={`Perfil de ${persona.name}`}>
        <div className="brand-persona__identity">
          <Avatar name={persona.name} size="lg" className="brand-persona__avatar" />
          <h3 ref={headingRef} tabIndex={-1} className="brand-persona__name">{persona.name}</h3>
          {role !== '' && <p className="brand-persona__role">{role}</p>}
          <p className="brand-persona__description">{persona.description ?? NOT_INFORMED}</p>
          {persona.traits.length > 0 && <div className="brand-persona__traits">
            {persona.traits.map((trait) => <Trait key={trait}>{trait}</Trait>)}
          </div>}
          {canEdit && <div className="brand-persona__actions">
            <Button size="sm" variant="secondary" leadingIcon={<Pencil />} blockedReason={blocked} onClick={() => startEditing(null)}>Editar</Button>
            <Button size="sm" variant="danger-quiet" leadingIcon={<Trash2 />} blockedReason={blocked} onClick={() => { setFormError(undefined); setConfirmingDelete(true); }}>Excluir</Button>
          </div>}
          {formError !== undefined && <FieldMessage role="alert">{formError}</FieldMessage>}
        </div>
        <div className="brand-persona__rows">
          {PROFILE_ROWS.map(([field, label, RowIcon, what]) => <div key={field} className="brand-persona__row">
            <span className="brand-persona__row-icon" aria-hidden="true"><RowIcon /></span>
            <div>
              <h4>{label}</h4>
              <p className="brand-section__body">{persona[field] ?? NOT_INFORMED}</p>
            </div>
            {canEdit && <IconButton label={`Editar ${what}`} icon={<Pencil />} blockedReason={blocked} onClick={() => startEditing(field)} />}
          </div>)}
        </div>
      </aside>
    </div>
    <div className="brand-persona__conversations">
      <StudyConversation client={client} subject={{ personaId: persona.id }} subjectLabel={persona.name} readOnly={false} headingLevel={4} />
    </div>
    <ConfirmDialog
      open={confirmingDelete}
      title={`Excluir a persona ${persona.name}?`}
      description={deleteDescription(persona)}
      confirmLabel="Excluir"
      cancelLabel="Cancelar"
      busy={remove.isPending}
      onConfirm={() => remove.mutate()}
      onCancel={() => { if (!remove.isPending) setConfirmingDelete(false); }}
    />
  </div>;
}

/**
 * The personas section: a grid of the personas with the way to add another, and the profile of one persona when the address names it.
 */
export function PersonasSection({ client, personas, canEdit, active, selectedId, awaiting, lastMissing }: {
  client: ClientDetailResponse;
  /** The one section still unfilled when the study lacks only one; the note under the list names it. */
  lastMissing: SectionKey | null;
  personas: Persona[];
  canEdit: boolean;
  /** This section is the one on screen: only then does the focus follow an open or a return. */
  active: boolean;
  selectedId: string | null;
  awaiting: AwaitingCounts;
}) {
  const blocked = useWriteBlocked();
  const location = useLocation();
  const [creating, setCreating] = useState(false);
  const [drafts, setDrafts] = useState<ReadonlyMap<string, PersonaDraft>>(() => new Map());
  const headingRef = useRef<HTMLHeadingElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const previousSelected = useRef(selectedId);

  // Opening a profile puts the focus on its name; coming back puts it on the card just left, so the keyboard keeps its place.
  useEffect(() => {
    const before = previousSelected.current;
    previousSelected.current = selectedId;
    if (!active || before === selectedId) return;
    if (selectedId !== null) { headingRef.current?.focus(); return; }
    const card = before === null ? null : gridRef.current?.querySelector<HTMLElement>(`[data-persona-id="${before}"]`);
    card?.focus();
  }, [active, selectedId]);

  const selected = selectedId === null ? null : personas.find((persona) => persona.id === selectedId) ?? null;

  const newPersona = <Button size="sm" variant="secondary" leadingIcon={<Plus />} blockedReason={blocked} onClick={() => setCreating(true)}>Nova persona</Button>;
  const createDialog = creating && <CreatePersonaDialog client={client} onClose={() => setCreating(false)} />;

  const cards = (current: string | null) => <ul className="brand-personas__list">
    {personas.map((persona) => {
      const role = personaRole(persona);
      return <li key={persona.id}>
        <Link
          className="brand-personas__card"
          data-persona-id={persona.id}
          to={{ search: personaSearch(persona.id) }}
          state={location.state}
          aria-current={persona.id === current ? 'true' : undefined}
        >
          <Avatar name={persona.name} size="lg" />
          <span className="brand-personas__body">
            <span className="brand-personas__name">{persona.name}</span>
            {role !== '' && <span className="brand-personas__role">{role}</span>}
            {role === '' && persona.id !== current && persona.description !== null && <span className="brand-personas__description">{persona.description}</span>}
            {persona.traits.length > 0 && <span className="brand-personas__traits">
              {persona.traits.map((trait) => <Trait key={trait}>{trait}</Trait>)}
            </span>}
            <AwaitingPill count={awaiting.persona[persona.id]} />
          </span>
          <ChevronRight className="brand-personas__go" aria-hidden="true" />
        </Link>
      </li>;
    })}
  </ul>;

  const listHeader = <header className="brand-personas__header">
    <h3>{SECTION_LABELS.personas}</h3>
    {canEdit && personas.length > 0 && newPersona}
  </header>;

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
    const list = <div className="brand-personas" ref={gridRef}>
      {listHeader}
      {cards(personaId)}
    </div>;
    return <>
      <PersonaProfile key={personaId} client={client} persona={selected} canEdit={canEdit} backState={location.state} headingRef={headingRef} draft={drafts.get(personaId) ?? null} onDraft={onDraft} list={list} />
      {createDialog}
    </>;
  }

  return <PanelLayout conversation={active ? <StudyConversation client={client} subject={{ sectionKey: 'personas' }} subjectLabel={SECTION_LABELS.personas} readOnly={false} /> : null}>
    <div className="brand-personas" ref={gridRef}>
      {listHeader}
      <p className="brand-personas__intro">{`Para quem ${client.name} escreve. Cada post deve ter uma delas em mente.`}</p>
      {personas.length === 0
        ? <EmptyState
          className="brand-section__empty"
          headingLevel={4}
          title="Nenhuma persona ainda"
          description={canEdit ? 'Descreva para quem a marca fala: dores, desejos e objeções.' : undefined}
          action={canEdit ? newPersona : undefined}
        />
        : cards(null)}

      {lastMissing !== null && <div className="brand-note">
        <Stage3D src="/3d/bulb.png" tone="indigo" size="sm" />
        <div>
          <p className="brand-note__title">{lastMissing === 'observations' ? 'Falta uma pergunta para fechar o estudo' : 'Falta uma seção para fechar o estudo'}</p>
          <p className="brand-note__text">{lastMissing === 'observations'
            ? 'Observações é a última seção. Anote o que o dono não quer ver nos posts: isso evita retrabalho na aprovação.'
            : `${SECTION_LABELS[lastMissing]} é a última seção que falta preencher.`}</p>
        </div>
      </div>}

      {createDialog}
    </div>
  </PanelLayout>;
}
