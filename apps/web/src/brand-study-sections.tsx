import { useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus } from 'lucide-react';

import {
  ARCHETYPE_LABELS,
  ArchetypeSchema,
  BrandStudySectionSchema,
  type BrandColor,
  type BrandStudyResponse,
  type BrandStudySection,
  type ClientDetailResponse
} from '@ageniza/contracts';
import { Button, EmptyState, Field, FieldMessage, Select, Textarea, TextInput, useFormErrors } from '@ageniza/ui';

import { useAgencyContext, useWriteBlocked } from './agency.js';
import { apiPath } from './api-path.js';
import { formatAgencyDayMonth } from './client-detail.js';
import { useApiClient } from './http.js';
import {
  brandStudyQueryKey,
  invalidateStudyWrites,
  SECTION_LABELS,
  sectionMutationError,
  type SectionKey,
  type TextSectionKey
} from './brand-study-model.js';

const EMPTY_SECTION = 'Ainda não preenchida';
const COLORS_INVALID = 'Cada cor precisa de um nome e de um código hexadecimal como #7A1F2B.';

/** What each unfilled section asks for: shown only to whoever can fill it. */
const EMPTY_HINTS: Record<Exclude<SectionKey, 'personas'>, string> = {
  branding: 'Conte quem é a marca e o que ela defende.',
  tone_of_voice: 'Registre como a marca fala com o público.',
  colors: 'Cadastre as cores da marca, cada uma com nome e código.',
  positioning: 'Diga onde a marca se coloca diante dos concorrentes.',
  archetype: 'Escolha o arquétipo que melhor descreve a marca.',
  observations: 'Anote o que a equipe precisa lembrar sobre este cliente.'
};

/** The archetype options: the English key travels, the Portuguese label is what people read (§3). */
const ARCHETYPE_OPTIONS = ArchetypeSchema.options.map((key) => ({ value: key, label: ARCHETYPE_LABELS[key] }));

const HEX_PATTERN = /^#[0-9A-Fa-f]{6}$/;

/** The empty section: what is missing and the one way to fill it. Without permission it only says it is missing. */
function EmptySection({ sectionKey, canEdit, onFill }: { sectionKey: Exclude<SectionKey, 'personas'>; canEdit: boolean; onFill: () => void }) {
  const blocked = useWriteBlocked();
  return <EmptyState
    className="brand-section__empty"
    headingLevel={4}
    title={EMPTY_SECTION}
    description={canEdit ? EMPTY_HINTS[sectionKey] : undefined}
    action={canEdit ? <Button size="sm" variant="secondary" leadingIcon={<Plus />} aria-label={`Preencher ${SECTION_LABELS[sectionKey]}`} blockedReason={blocked} onClick={onFill}>Preencher</Button> : undefined}
  />;
}

/** The last editor and day of a section, in the agency's timezone (review lessons of #379). */
function UpdatedBy({ section }: { section: BrandStudySection | undefined }) {
  if (section === undefined || section.updatedBy === null || section.updatedAt === null) return null;
  return <p className="brand-section__updated">editado por {section.updatedBy.name} · {formatAgencyDayMonth(section.updatedAt)}</p>;
}

/** The content of one section in a card: the title, who last edited it and the way to edit it live in the header. */
function SectionCard({ title, section, action, children }: { title: string; section: BrandStudySection | undefined; action?: ReactNode; children: ReactNode }) {
  return <article className="brand-section">
    <header className="brand-section__header">
      <h3>{title}</h3>
      <UpdatedBy section={section} />
      {action !== undefined && <div className="brand-section__header-action">{action}</div>}
    </header>
    {children}
  </article>;
}

/** The card and, beside it (or under it, when it does not fit), the conversations of the same subject. */
export function PanelLayout({ children, conversation }: { children: ReactNode; conversation?: ReactNode }) {
  return <div className="brand-panel__layout">
    <div className="brand-panel__main">{children}</div>
    {conversation !== undefined && conversation !== null && <div className="brand-panel__conversations">{conversation}</div>}
  </div>;
}

const useSectionSave = (client: ClientDetailResponse, sectionKey: SectionKey, onSaved: () => void, onFailed: (error: unknown) => void) => {
  const agency = useAgencyContext();
  const httpClient = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) => httpClient.request({
      path: apiPath('/agencies/:agencyId/clients/:clientId/brand-study/sections/:sectionKey', {
        agencyId: agency.agencyId,
        clientId: client.id,
        sectionKey
      }),
      method: 'PUT',
      body,
      response: BrandStudySectionSchema
    }),
    onSuccess: (updated) => {
      onSaved();
      queryClient.setQueryData<BrandStudyResponse>(brandStudyQueryKey(agency.agencyId, client.id), (current) =>
        current === undefined ? current : { ...current, sections: current.sections.map((item) => (item.key === sectionKey ? updated : item)) });
      invalidateStudyWrites(queryClient, agency.agencyId, client.id);
    },
    onError: onFailed
  });
};

/** The in-place editor of a free-text section (Branding, Tom de voz, Posicionamento, Observações). */
export function TextSection({ client, sectionKey, section, canEdit }: {
  client: ClientDetailResponse;
  sectionKey: TextSectionKey;
  section: BrandStudySection | undefined;
  canEdit: boolean;
}) {
  const blocked = useWriteBlocked();
  const { formRef, summary } = useFormErrors();
  const label = SECTION_LABELS[sectionKey];
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | undefined>();
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const save = useSectionSave(client, sectionKey, () => { setEditing(false); setError(undefined); }, (saveError) => { setError(sectionMutationError(saveError)); });

  const body = section?.body ?? null;
  const startEditing = (): void => {
    setDraft(body ?? '');
    setError(undefined);
    setEditing(true);
    // The textarea mounts on this same click; the focus waits for the next paint.
    globalThis.setTimeout(() => textareaRef.current?.focus(), 0);
  };

  if (!editing) {
    if (body === null) return <SectionCard title={label} section={section}><EmptySection sectionKey={sectionKey} canEdit={canEdit} onFill={startEditing} /></SectionCard>;
    return <SectionCard
      title={label}
      section={section}
      action={canEdit ? <Button size="sm" variant="secondary" leadingIcon={<Pencil />} aria-label={`Editar ${label}`} blockedReason={blocked} onClick={startEditing}>Editar</Button> : undefined}
    >
      <p className="brand-section__body">{body}</p>
    </SectionCard>;
  }

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    // The column rejects whitespace-only text (400); the screen refuses it before the request and
    // keeps the draft, so nothing typed is lost.
    if (draft.trim() === '') { setError('Escreva o conteúdo da seção.'); return; }
    save.mutate({ body: draft });
  };

  return <SectionCard title={label} section={section}>
    <form ref={formRef} className="brand-section__editor" onSubmit={onSubmit} noValidate>
      {summary}
      <Field label={`Editar ${label}`} error={error}>
        {(control) => <Textarea
          ref={textareaRef}
          {...control}
          name={sectionKey}
          value={draft}
          rows={6}
          onChange={(event) => { setDraft(event.target.value); setError(undefined); }}
        />}
      </Field>
      <div className="brand-section__actions">
        <Button type="submit" size="sm" loading={save.isPending}>Salvar</Button>
        <Button type="button" size="sm" variant="ghost" disabled={save.isPending} onClick={() => { setEditing(false); setError(undefined); }}>Cancelar</Button>
      </div>
    </form>
  </SectionCard>;
}

/** The colours as swatches with name and code, up to 24 (the API cap). */
export function ColorsSection({ client, section, canEdit }: { client: ClientDetailResponse; section: BrandStudySection | undefined; canEdit: boolean }) {
  const blocked = useWriteBlocked();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<BrandColor[]>([]);
  const [error, setError] = useState<string | undefined>();

  const save = useSectionSave(client, 'colors', () => { setEditing(false); setError(undefined); }, (saveError) => { setError(sectionMutationError(saveError)); });

  const colors = section?.colors ?? null;
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
    if (colors === null || colors.length === 0) return <SectionCard title={SECTION_LABELS.colors} section={section}><EmptySection sectionKey="colors" canEdit={canEdit} onFill={startEditing} /></SectionCard>;
    return <SectionCard
      title={SECTION_LABELS.colors}
      section={section}
      action={canEdit ? <Button size="sm" variant="secondary" leadingIcon={<Pencil />} aria-label="Editar Cores" blockedReason={blocked} onClick={startEditing}>Editar</Button> : undefined}
    >
      <ul className="brand-colors">
        {colors.map((color) => <li key={`${color.name}-${color.hex}`} className="brand-colors__item">
          <span className="brand-colors__swatch" style={{ background: color.hex }} aria-hidden="true" />
          <span className="brand-colors__name">{color.name}</span>
          <span className="brand-colors__hex">{color.hex}</span>
        </li>)}
      </ul>
    </SectionCard>;
  }

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const filled = draft.filter((color) => color.name.trim() !== '' || color.hex.trim() !== '');
    // Removing every row is clearing the section: the contract accepts `colors: []` and the API
    // reads it as not filled, so the last removal travels instead of getting stuck (review of #388).
    if (filled.length === 0) { save.mutate({ colors: [] }); return; }
    if (filled.some((color) => color.name.trim() === '' || !HEX_PATTERN.test(color.hex.trim()))) { setError(COLORS_INVALID); return; }
    save.mutate({ colors: filled.map((color) => ({ name: color.name.trim(), hex: color.hex.trim() })) });
  };

  return <SectionCard title={SECTION_LABELS.colors} section={section}>
    <form className="brand-section__editor" onSubmit={onSubmit} noValidate>
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
        <Button type="button" size="sm" variant="secondary" leadingIcon={<Plus />} disabled={draft.length >= 24} onClick={() => { setDraft((current) => [...current, { name: '', hex: '' }]); setError(undefined); }}>Adicionar cor</Button>
      </div>
      {error !== undefined && <FieldMessage role="alert">{error}</FieldMessage>}
      <div className="brand-section__actions">
        <Button type="submit" size="sm" loading={save.isPending}>Salvar</Button>
        <Button type="button" size="sm" variant="ghost" disabled={save.isPending} onClick={() => { setEditing(false); setError(undefined); }}>Cancelar</Button>
      </div>
    </form>
  </SectionCard>;
}

/** The archetype: one of the twelve, chosen by the Portuguese label and shown large. */
export function ArchetypeSection({ client, section, canEdit }: { client: ClientDetailResponse; section: BrandStudySection | undefined; canEdit: boolean }) {
  const blocked = useWriteBlocked();
  const { formRef, summary } = useFormErrors();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | undefined>();

  const save = useSectionSave(client, 'archetype', () => { setEditing(false); setError(undefined); }, (saveError) => { setError(sectionMutationError(saveError)); });

  const archetype = section?.archetype ?? null;
  const label = archetype === null ? null : ARCHETYPE_LABELS[archetype];
  const startEditing = (): void => { setDraft(archetype ?? ''); setError(undefined); setEditing(true); };

  if (!editing) {
    if (label === null) return <SectionCard title={SECTION_LABELS.archetype} section={section}><EmptySection sectionKey="archetype" canEdit={canEdit} onFill={startEditing} /></SectionCard>;
    return <SectionCard
      title={SECTION_LABELS.archetype}
      section={section}
      action={canEdit ? <Button size="sm" variant="secondary" leadingIcon={<Pencil />} aria-label="Editar Arquétipo" blockedReason={blocked} onClick={startEditing}>Editar</Button> : undefined}
    >
      <p className="brand-archetype">{label}</p>
    </SectionCard>;
  }

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (draft === '') { setError('Escolha um arquétipo da lista.'); return; }
    save.mutate({ archetype: draft });
  };

  return <SectionCard title={SECTION_LABELS.archetype} section={section}>
    <form ref={formRef} className="brand-section__editor" onSubmit={onSubmit} noValidate>
      {summary}
      <Select
        label="Arquétipo"
        value={draft}
        placeholder="Selecione"
        options={ARCHETYPE_OPTIONS}
        error={error}
        onChange={(value) => { setDraft(value); setError(undefined); }}
      />
      <div className="brand-section__actions">
        <Button type="submit" size="sm" loading={save.isPending}>Salvar</Button>
        <Button type="button" size="sm" variant="ghost" disabled={save.isPending} onClick={() => { setEditing(false); setError(undefined); }}>Cancelar</Button>
      </div>
    </form>
  </SectionCard>;
}
