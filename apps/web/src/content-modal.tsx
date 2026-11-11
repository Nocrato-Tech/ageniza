import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocation, useNavigate, useOutletContext, useParams, useSearchParams } from 'react-router-dom';
import { Pencil, Save } from 'lucide-react';

import {
  CalendarDaySchema,
  ContentDetailSchema,
  type ContentDetail,
  type ContentFormat,
  type ContentStatus,
  type CreateContentRequest,
  type MediaFolderAsset,
  type UpdateContentRequest
} from '@ageniza/contracts';
import { Button, DatePicker, Dialog, Field, FieldMessage, FormatTag, Select, Skeleton, StatusTag, Tabs, Textarea, TextInput } from '@ageniza/ui';

import { useAgencyContext, useCan, useWriteBlocked } from './agency.js';
import { apiPath } from './api-path.js';
import { useContentsAddress } from './content-address.js';
import { todayInSaoPaulo } from './content-dates.js';
import {
  changesOf,
  fitMedia,
  hasCover,
  mediaFromFolder,
  resetsApproval,
  saveRefusal,
  validate,
  valuesOf,
  type ContentFieldErrors,
  type ContentFormValues
} from './content-form.js';
import { ContentActions } from './content-action-bar.js';
import { ContentClientView } from './content-client-view.js';
import { FORMAT_LABELS, FORMAT_TONES, isClosed, STATUS_LABELS, STATUS_TAGS } from './content-labels.js';
import { ContentAssignment } from './content-assignment.js';
import { CoverField, FolderField, MediaField, useFreshFolder } from './content-media.js';
import { Conversation } from './conversation.js';
import { captionCounter, ContentPreview } from './content-preview.js';
import { HttpClientError, useApiClient } from './http.js';

/** What the client page hands the modal it renders in its `Outlet`: the rules that belong to the client, not to the content. */
export interface ContentsOutletContext {
  readonly clientId: string;
  /** `conteudo.operar` on a client that is known and not archived. UX only: the API checks it on every write. */
  readonly canEdit: boolean;
  /** The client was read: before that, `canEdit` is false because nothing is known, not because the person may not. */
  readonly ready: boolean;
  readonly archived: boolean;
  readonly handle: string | null;
}

const CONTENT_PATH = '/agencies/:agencyId/clients/:clientId/contents/:contentId';
const CONTENTS_PATH = '/agencies/:agencyId/clients/:clientId/contents';

/** Why the conversation takes no new message at this step of the content (specs/conteudo.md section 6); the API decides, this only says it first. */
const NOT_OPEN_REASONS: Readonly<Partial<Record<ContentStatus, string>>> = {
  in_production: 'A conversa só aceita mensagens a partir de "Aguardando aprovação"; este conteúdo ainda está em produção.',
  cancelled: 'Este conteúdo foi cancelado: a conversa não recebe mais mensagens.'
};

const FORMAT_OPTIONS = (Object.keys(FORMAT_LABELS) as Array<keyof typeof FORMAT_LABELS>).map((value) => ({ value, label: FORMAT_LABELS[value] }));

/** Which step of create-then-edit failed, and whether the content was already created when it did. */
class SaveFailed extends Error {
  public constructor(public readonly created: boolean, public readonly reason: unknown) {
    super('The content could not be saved.');
  }
}

/** The way back to the calendar the person came from: the same period, the same roster address. */
const useCloseTo = (clientId: string): (() => void) => {
  const address = useContentsAddress(clientId);
  const navigate = useNavigate();
  const location = useLocation();
  return () => {
    const params = new URLSearchParams(location.search);
    params.delete('dia');
    const search = params.toString();
    navigate({ pathname: address, search: search === '' ? '' : `?${search}` }, { state: location.state });
  };
};

function ContentEditor({ context, initial, initialDay, onBusyChange, onDirtyChange, onDone }: {
  context: ContentsOutletContext;
  initial: ContentDetail | null;
  initialDay: string;
  onBusyChange: (busy: boolean) => void;
  onDirtyChange: (dirty: boolean) => void;
  /** Closes after a success: it never asks, because nothing is left to lose. */
  onDone: () => void;
}) {
  const httpClient = useApiClient();
  const agency = useAgencyContext();
  const queryClient = useQueryClient();
  const canOperate = useCan('conteudo.operar');
  const blocked = useWriteBlocked();
  const ids = useId();
  const { clientId } = context;

  // The content as the server holds it. An open content is the one the query reads again after every write of the Atribuição tab (a
  // subtask approved or created there moves "what is missing" and the send button here), so it is never copied into state: what is
  // typed lives in `form` and is untouched by a new read. A content born in this modal is held until the query of its own exists.
  const [born, setBorn] = useState<ContentDetail | null>(null);
  const saved = initial ?? born;
  const [form, setForm] = useState<ContentFormValues>(() => initial === null
    ? { title: '', format: 'image', publishOn: initialDay, publishAtTime: '', folderId: '', caption: '', mediaAssetIds: [], coverAssetId: null }
    : valuesOf(initial));
  const initialForm = useRef(form);
  const [errors, setErrors] = useState<ContentFieldErrors>({});
  const [formError, setFormError] = useState<string | undefined>();

  const closed = saved !== null && isClosed(saved.status);
  const editable = context.canEdit && !closed;
  const writable = editable && blocked === undefined;
  const changes = saved === null ? null : changesOf(valuesOf(saved), form);
  const dirty = saved === null || (changes !== null && Object.keys(changes).length > 0);
  const unsaved = editable && (saved === null ? JSON.stringify(form) !== JSON.stringify(initialForm.current) : dirty);
  useEffect(() => { onDirtyChange(unsaved); }, [unsaved, onDirtyChange]);
  const approvalWarning = saved?.status === 'approved' && changes !== null && resetsApproval(valuesOf(saved), changes);
  const movesFolder = changes?.folderId !== undefined;

  // The folder is read when the person chooses it, and the form shows what the content would take from it. The API decides again
  // when the content is saved; what is held here is only the choice on screen.
  const readFolder = useFreshFolder(clientId);
  const [inheriting, setInheriting] = useState(false);
  const [folderUnread, setFolderUnread] = useState(false);
  // A file going up into the folder is part of the form: saving now would leave it out and close the modal over it.
  const [sendingFile, setSendingFile] = useState(false);
  const folderTicket = useRef(0);
  // What the last reading was for, so that a failed one can be asked again as it was, even for the same folder.
  const lastReading = useRef<{ folderId: string; pick: (assets: MediaFolderAsset[], current: ContentFormValues) => string[] } | null>(null);
  const inherit = async (folderId: string, pick: (assets: MediaFolderAsset[], current: ContentFormValues) => string[]): Promise<void> => {
    const ticket = folderTicket.current + 1;
    folderTicket.current = ticket;
    lastReading.current = { folderId, pick };
    setInheriting(true);
    setFolderUnread(false);
    try {
      const assets = await readFolder(folderId);
      if (folderTicket.current !== ticket) return;
      setForm((current) => (current.folderId === folderId ? { ...current, mediaAssetIds: pick(assets, current) } : current));
    } catch {
      if (folderTicket.current === ticket) setFolderUnread(true);
    } finally {
      if (folderTicket.current === ticket) setInheriting(false);
    }
  };

  const save = useMutation({
    mutationFn: async (): Promise<ContentDetail> => {
      let current = saved;
      let created = false;
      if (current === null) {
        try {
          current = await httpClient.request({
            path: apiPath(CONTENTS_PATH, { agencyId: agency.agencyId, clientId }),
            method: 'POST',
            body: {
              title: form.title,
              format: form.format,
              publishOn: form.publishOn,
              publishAtTime: form.publishAtTime === '' ? null : form.publishAtTime,
              caption: form.caption,
              folderId: form.folderId,
              mediaAssetIds: [...form.mediaAssetIds],
              ...(form.coverAssetId === null ? {} : { coverAssetId: form.coverAssetId })
            } satisfies CreateContentRequest,
            response: ContentDetailSchema
          });
        } catch (error) {
          throw new SaveFailed(false, error);
        }
        created = true;
        // What the server stored is what is on screen from now on: a retry of the rest edits this content, never creates another.
        setBorn(current);
      }
      const rest: UpdateContentRequest = changesOf(valuesOf(current), form);
      if (Object.keys(rest).length === 0) return current;
      try {
        return await httpClient.request({
          path: apiPath(CONTENT_PATH, { agencyId: agency.agencyId, clientId, contentId: current.id }),
          method: 'PATCH',
          body: rest,
          response: ContentDetailSchema
        });
      } catch (error) {
        throw new SaveFailed(created, error);
      }
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['agency', agency.agencyId, 'contents', clientId] });
      onDone();
    },
    onError: (error) => {
      const failure = error instanceof SaveFailed ? error : new SaveFailed(false, error);
      const refusal = saveRefusal(failure.reason, saved === null && !failure.created, movesFolder);
      setErrors(refusal.fields);
      setFormError(failure.created ? `${refusal.message} O conteúdo já foi criado: ao salvar de novo, só o que falta é enviado.` : refusal.message);
      // A refusal means the calendar behind the modal may be stale (the client was archived, another operator moved it).
      if (failure.created || (failure.reason instanceof HttpClientError && failure.reason.status !== undefined && failure.reason.status < 500)) {
        void queryClient.invalidateQueries({ queryKey: ['agency', agency.agencyId, 'contents', clientId] });
      }
    }
  });

  // The calendar card shows the last message and the count; a write in the conversation moves both. The content of this modal is not read
  // again from here: a refused message must keep its text in the box, and the box is gone once the state read says the content is closed.
  const refreshContents = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['agency', agency.agencyId, 'contents', clientId], predicate: (query) => query.queryKey[4] !== 'modal' });
  };

  const [moving, setMoving] = useState(false);
  const busy = save.isPending || moving;
  useEffect(() => { onBusyChange(busy || sendingFile); }, [busy, sendingFile, onBusyChange]);

  const edit = (patch: Partial<ContentFormValues>, field?: keyof ContentFieldErrors): void => {
    setForm((current) => ({ ...current, ...patch }));
    if (field !== undefined) setErrors((current) => ({ ...current, [field]: undefined }));
    setFormError(undefined);
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setFormError(undefined);
    if (inheriting || folderUnread || sendingFile) return;
    const problems = validate(form);
    setErrors(problems);
    if (Object.keys(problems).length > 0) return;
    save.mutate();
  };

  const chooseFolder = (folderId: string): void => {
    edit({ folderId, mediaAssetIds: [], coverAssetId: null }, 'folderId');
    void inherit(folderId, (assets, current) => mediaFromFolder(current.format, assets));
  };
  const chooseFormat = (format: ContentFormat): void => {
    edit({ format, ...(hasCover(format) ? {} : { coverAssetId: null }) }, 'media');
    if (form.folderId !== '') void inherit(form.folderId, (assets, current) => fitMedia(current.format, current.mediaAssetIds, assets));
  };

  /** What choosing another folder does to a content that exists, said before it happens; nothing to say when nothing is lost. */
  const folderWarning = ((): string | undefined => {
    if (saved === null) return undefined;
    const hasMedia = form.mediaAssetIds.length > 0;
    const hasCoverNow = form.coverAssetId !== null;
    const sent = saved.status === 'awaiting_approval' || saved.status === 'approved';
    if (!hasMedia && !hasCoverNow && !sent) return undefined;
    const sentences: string[] = [];
    if (hasMedia && hasCoverNow) sentences.push('A mídia e a capa de agora saem do conteúdo, e entram as da pasta nova.');
    else if (hasMedia) sentences.push('A mídia de agora sai do conteúdo, e entra a da pasta nova.');
    else if (hasCoverNow) sentences.push('A capa de agora sai do conteúdo.');
    else sentences.push('A mídia do conteúdo passa a ser a da pasta nova.');
    if (saved.status === 'approved') sentences.push('O conteúdo está aprovado e volta para “Aguardando aprovação”.');
    if (sent) sentences.push('Um conteúdo enviado para aprovação não fica sem mídia: se a pasta nova estiver vazia, envie uma mídia aqui antes de salvar.');
    return sentences.join(' ');
  })();
  const note = !context.canEdit
    ? (context.archived ? 'Cliente arquivado: o conteúdo é só leitura.' : 'Você pode ver este conteúdo, mas não editar.')
    : closed ? 'Este conteúdo já foi publicado ou cancelado e não pode mais ser editado.' : blocked;
  const captionError = errors.caption;
  const formId = `${ids}-form`;
  const conversation = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null);
  // "Fechar" is Esc: the dialog owns the question about what was typed, so the button asks it the way the platform does.
  const requestClose = (): void => { root.current?.closest('dialog')?.dispatchEvent(new Event('cancel', { cancelable: true })); };
  const seeConversation = (): void => {
    conversation.current?.scrollIntoView?.({ block: 'start' });
    conversation.current?.focus({ preventScroll: true });
  };

  const dayField = () => {
    const error = errors.publishOn;
    return <Field label="Data">
      {(control) => <>
        <DatePicker
          {...control}
          today={todayInSaoPaulo()}
          toggleLabel="Abrir calendário da data"
          value={form.publishOn}
          disabled={busy || !writable}
          onChange={(day) => edit({ publishOn: day }, 'publishOn')}
          aria-invalid={error === undefined ? undefined : true}
          aria-describedby={error === undefined ? undefined : `${control.id}-error`}
        />
        {error !== undefined && <FieldMessage id={`${control.id}-error`} role="alert">{error}</FieldMessage>}
      </>}
    </Field>;
  };

  const textField = (field: 'title' | 'publishAtTime', label: string, type?: 'time') => {
    const error = errors[field];
    return <Field label={label}>
      {(control) => <>
        <TextInput
          {...control}
          type={type}
          value={form[field]}
          disabled={busy || !writable}
          onChange={(event) => edit({ [field]: event.target.value }, field)}
          aria-invalid={error !== undefined}
          aria-describedby={error === undefined ? undefined : `${control.id}-error`}
        />
        {error !== undefined && <FieldMessage id={`${control.id}-error`} role="alert">{error}</FieldMessage>}
      </>}
    </Field>;
  };

  const formActions = <div className="content-modal__form-actions">
    <Button variant="ghost" disabled={busy || sendingFile} onClick={requestClose}>Fechar</Button>
    {editable && <Button type="submit" form={formId} variant={dirty ? 'primary' : 'secondary'} leadingIcon={<Save />} loading={busy} disabled={busy || inheriting || folderUnread || sendingFile || (!dirty && blocked === undefined)} blockedReason={blocked}>{saved === null ? 'Criar conteúdo' : 'Salvar'}</Button>}
  </div>;

  return <div className="content-modal" ref={root}>
    {saved?.status === 'adjusting' && <div className="content-modal__adjustment" role="note">
      <Pencil aria-hidden="true" />
      <p><strong>O cliente pediu ajuste.</strong> O pedido está na conversa; reenvie para aprovação quando o conteúdo estiver pronto.</p>
      <Button size="sm" variant="secondary" onClick={seeConversation}>Ver na conversa</Button>
    </div>}
    <div className="content-modal__body">
      <ContentPreview values={form} handle={context.handle} />
      <form id={formId} className="form-stack content-modal__form" onSubmit={onSubmit} noValidate>
        {note !== undefined && <p className="form-hint" role="note">{note}</p>}
        {textField('title', 'Título')}
        <Select
          label="Formato"
          value={form.format}
          options={FORMAT_OPTIONS}
          disabled={busy || !writable}
          onChange={(value) => {
            const format = FORMAT_OPTIONS.find((option) => option.value === value)?.value;
            if (format !== undefined) chooseFormat(format);
          }}
        />
        <div className="content-modal__when">
          {dayField()}
          {textField('publishAtTime', 'Hora', 'time')}
        </div>
        <FolderField
          clientId={clientId}
          value={form.folderId}
          disabled={busy || !writable}
          canCreate={context.canEdit && blocked === undefined}
          error={errors.folderId ?? (folderUnread ? 'Não foi possível ler a pasta. Tente de novo.' : undefined)}
          onRetry={folderUnread && !inheriting ? () => { const last = lastReading.current; if (last !== null) void inherit(last.folderId, last.pick); } : undefined}
          hint="O conteúdo usa a mídia que está na pasta. Pasta vazia? Envie a mídia por aqui."
          warning={folderWarning}
          onChange={chooseFolder}
        />
        <MediaField
          clientId={clientId}
          folderId={form.folderId}
          format={form.format}
          selected={form.mediaAssetIds}
          disabled={busy || !writable}
          canSend={context.canEdit && blocked === undefined}
          error={errors.media}
          onChange={(mediaAssetIds) => edit({ mediaAssetIds }, 'media')}
          onSendingChange={setSendingFile}
        />
        {sendingFile && <p className="form-hint" role="status">Aguarde o envio da mídia terminar para salvar o conteúdo.</p>}
        {hasCover(form.format) && <CoverField
          clientId={clientId}
          folderId={form.folderId}
          value={form.coverAssetId}
          disabled={busy || !writable}
          error={errors.cover}
          onChange={(coverAssetId) => edit({ coverAssetId }, 'cover')}
        />}
        <Field label="Legenda" hint={captionCounter(form.caption)} className="content-modal__caption">
          {(control) => <>
            <Textarea
              {...control}
              rows={6}
              value={form.caption}
              disabled={busy || !writable}
              onChange={(event) => edit({ caption: event.target.value }, 'caption')}
              aria-invalid={captionError !== undefined}
              aria-describedby={captionError === undefined ? control['aria-describedby'] : `${control['aria-describedby']} ${control.id}-error`}
            />
            {captionError !== undefined && <FieldMessage id={`${control.id}-error`} role="alert">{captionError}</FieldMessage>}
          </>}
        </Field>
        {approvalWarning && <p className="form-hint" role="status">
          Este conteúdo está aprovado. Mudar a legenda, a mídia, a capa, a pasta ou o formato o devolve para “Aguardando aprovação”.
        </p>}
        {formError !== undefined && <FieldMessage role="alert">{formError}</FieldMessage>}
      </form>
    </div>
    {/* Outside the form: the conversation has forms of its own, and a submit inside would also submit this one. */}
    {saved !== null && <div className="content-modal__conversation" ref={conversation} tabIndex={-1}>
      <Conversation
        scope={{ side: 'agency', agencyId: agency.agencyId, clientId }}
        subject={{ contentId: saved.id }}
        subjectLabel={saved.title}
        canWrite={canOperate}
        readOnly={context.archived}
        blockedReason={NOT_OPEN_REASONS[saved.status]}
        planBlockedReason={blocked}
        headingLevel={3}
        onWritten={refreshContents}
        onStale={refreshContents}
      />
    </div>}
    <footer className="content-modal__footer">
      {saved !== null && !context.archived
        ? <ContentActions clientId={clientId} content={saved} dirty={dirty} onBusyChange={setMoving} onDone={onDone}>{formActions}</ContentActions>
        : <div className="content-modal__footer-row">{formActions}</div>}
    </footer>
  </div>;
}

/** What the content is and where it stands, in the two tags the calendar card also wears. */
function ContentTags({ content }: { content: ContentDetail }) {
  return <p className="content-modal__tags">
    <FormatTag format={FORMAT_TONES[content.format]}>{FORMAT_LABELS[content.format]}</FormatTag>
    <StatusTag status={STATUS_TAGS[content.status]}>{STATUS_LABELS[content.status]}</StatusTag>
  </p>;
}

/**
 * The modal around the editor: the tabs and a close that waits for a write. Geral stays mounted while the other tabs are open, so what was typed
 * in the form is still there when the person comes back. Atribuição and "Como o cliente vê" exist once there is a content to attribute and to show.
 * A close with something typed asks first, by the dialog's own `confirmDiscard`; a close after a success never does.
 */
function ContentDialog({ title, onClose, busy, dirty, summary, assignment, clientView, children }: {
  title: string;
  onClose: () => void;
  busy: boolean;
  dirty: boolean;
  summary?: ReactNode;
  assignment?: ReactNode;
  clientView?: ReactNode;
  children: ReactNode;
}) {
  const [tab, setTab] = useState<'general' | 'assignment' | 'client-view'>('general');
  const shown = (tab === 'assignment' && assignment !== undefined) || (tab === 'client-view' && clientView !== undefined) ? tab : 'general';
  // Closing in the middle of a write would leave its success to close whatever is open by then.
  return <Dialog
    title={title}
    closeLabel="Fechar conteúdo"
    size="lg"
    onClose={() => { if (!busy) onClose(); }}
    confirmDiscard={{
      dirty: dirty && !busy,
      title: 'Descartar alterações?',
      description: 'As alterações não salvas serão perdidas. Continue editando para salvá-las.',
      keepLabel: 'Continuar editando',
      discardLabel: 'Descartar alterações',
      closeLabel: 'Fechar confirmação de descarte'
    }}
  >
    {summary}
    <Tabs
      label="Seções do conteúdo"
      value={shown}
      onChange={(value) => setTab(value === 'assignment' || value === 'client-view' ? value : 'general')}
      items={[
        { value: 'general', label: 'Geral', keepMounted: true, content: children },
        { value: 'assignment', label: 'Atribuição', disabled: assignment === undefined, content: assignment },
        { value: 'client-view', label: 'Como o cliente vê', disabled: clientView === undefined, content: clientView }
      ]}
    />
  </Dialog>;
}

/** `/agencia/:agenciaId/conteudos/:clienteId/:conteudoId`: one content, read when it is opened and edited in place. */
export function ContentModalRoute() {
  const httpClient = useApiClient();
  const agency = useAgencyContext();
  const context = useOutletContext<ContentsOutletContext>();
  const { conteudoId = '' } = useParams();
  const close = useCloseTo(context.clientId);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const contentId = conteudoId.toLowerCase();
  const validId = ContentDetailSchema.shape.id.safeParse(contentId).success;

  const content = useQuery({
    queryKey: ['agency', agency.agencyId, 'contents', context.clientId, 'modal', contentId],
    queryFn: ({ signal }) => httpClient.request({
      path: apiPath(CONTENT_PATH, { agencyId: agency.agencyId, clientId: context.clientId, contentId }),
      response: ContentDetailSchema,
      signal
    }),
    enabled: validId,
    // Read when it is opened: a copy from a minute ago may be one another operator already approved or cancelled.
    staleTime: 0,
    gcTime: 0,
    refetchOnWindowFocus: false
  });

  // The answer must be about the content in the address, in the client of the address, or it is not shown at all.
  const data = content.data?.id.toLowerCase() === contentId && content.data.clientId.toLowerCase() === context.clientId ? content.data : undefined;
  const hidden = !validId || (content.isError && content.error instanceof HttpClientError && (content.error.status === 403 || content.error.status === 404))
    || (content.data !== undefined && data === undefined);

  const assignment = data === undefined || !context.ready ? undefined : <ContentAssignment clientId={context.clientId} content={data} archived={context.archived} />;
  return <ContentDialog title={data?.title ?? 'Conteúdo'} onClose={close} busy={busy} dirty={dirty} clientView={data === undefined ? undefined : <ContentClientView content={data} />} summary={data === undefined ? undefined : <ContentTags content={data} />} assignment={assignment}>
    {hidden
      ? <div className="form-stack content-modal__notice" role="alert">
        <p>Este conteúdo não existe mais ou você não tem acesso a ele.</p>
        <div className="form-actions"><Button variant="secondary" onClick={close}>Fechar</Button></div>
      </div>
      : content.isError
        ? <div className="form-stack content-modal__notice" role="alert">
          <p>Não foi possível carregar o conteúdo. Tente de novo.</p>
          <div className="form-actions">
            <Button onClick={() => { void content.refetch(); }}>Tentar de novo</Button>
            <Button variant="secondary" onClick={close}>Fechar</Button>
          </div>
        </div>
        : data === undefined || !context.ready
          ? <div className="content-modal__loading" aria-hidden="true"><Skeleton /><Skeleton /><Skeleton /></div>
          : <ContentEditor key={data.id} context={context} initial={data} initialDay={data.publishOn} onBusyChange={setBusy} onDirtyChange={setDirty} onDone={close} />}
  </ContentDialog>;
}

/** `/agencia/:agenciaId/conteudos/:clienteId/novo?dia=AAAA-MM-DD`: a new content, born in production on the day of the "+" or today. */
export function ContentCreateRoute() {
  const context = useOutletContext<ContentsOutletContext>();
  const [searchParams] = useSearchParams();
  const close = useCloseTo(context.clientId);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const day = CalendarDaySchema.safeParse(searchParams.get('dia'));
  return <ContentDialog title="Novo conteúdo" onClose={close} busy={busy} dirty={dirty}>
    {!context.ready
      ? <div className="content-modal__loading" aria-hidden="true"><Skeleton /><Skeleton /><Skeleton /></div>
      : context.canEdit
      ? <ContentEditor context={context} initial={null} initialDay={day.success ? day.data : todayInSaoPaulo()} onBusyChange={setBusy} onDirtyChange={setDirty} onDone={close} />
      : <div className="form-stack content-modal__notice" role="alert">
        <p>{context.archived ? 'Este cliente está arquivado: não recebe conteúdo novo.' : 'Você não tem permissão para criar conteúdos.'}</p>
        <div className="form-actions"><Button variant="secondary" onClick={close}>Fechar</Button></div>
      </div>}
  </ContentDialog>;
}
