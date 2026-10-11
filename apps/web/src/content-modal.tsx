import { useEffect, useId, useState, type FormEvent, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocation, useNavigate, useOutletContext, useParams, useSearchParams } from 'react-router-dom';

import {
  CalendarDaySchema,
  ContentDetailSchema,
  type ContentDetail,
  type CreateContentRequest,
  type UpdateContentRequest
} from '@ageniza/contracts';
import { Button, FieldMessage, Modal, Select, Skeleton, Textarea, TextInput } from '@ageniza/ui';

import { useAgencyContext } from './agency.js';
import { apiPath } from './api-path.js';
import { useContentsAddress } from './content-address.js';
import { todayInSaoPaulo } from './content-dates.js';
import {
  changesOf,
  hasCover,
  resetsApproval,
  saveRefusal,
  validate,
  valuesOf,
  type ContentFieldErrors,
  type ContentFormValues
} from './content-form.js';
import { FORMAT_LABELS, isClosed, STATUS_LABELS } from './content-labels.js';
import { CoverField, FolderField, MediaField } from './content-media.js';
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

function ContentEditor({ context, initial, initialDay, onBusyChange, onDone }: {
  context: ContentsOutletContext;
  initial: ContentDetail | null;
  initialDay: string;
  onBusyChange: (busy: boolean) => void;
  onDone: () => void;
}) {
  const httpClient = useApiClient();
  const agency = useAgencyContext();
  const queryClient = useQueryClient();
  const ids = useId();
  const { clientId } = context;

  const [saved, setSaved] = useState<ContentDetail | null>(initial);
  const [form, setForm] = useState<ContentFormValues>(() => initial === null
    ? { title: '', format: 'image', publishOn: initialDay, publishAtTime: '', folderId: '', caption: '', mediaAssetIds: [], coverAssetId: null }
    : valuesOf(initial));
  const [errors, setErrors] = useState<ContentFieldErrors>({});
  const [formError, setFormError] = useState<string | undefined>();

  const closed = saved !== null && isClosed(saved.status);
  const writable = context.canEdit && !closed;
  const changes = saved === null ? null : changesOf(valuesOf(saved), form);
  const dirty = saved === null || (changes !== null && Object.keys(changes).length > 0);
  const approvalWarning = saved?.status === 'approved' && changes !== null && resetsApproval(changes);

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
              folderId: form.folderId
            } satisfies CreateContentRequest,
            response: ContentDetailSchema
          });
        } catch (error) {
          throw new SaveFailed(false, error);
        }
        created = true;
        // What the server stored is what is on screen from now on: a retry of the rest edits this content, never creates another.
        setSaved(current);
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
      const refusal = saveRefusal(failure.reason, saved === null && !failure.created);
      setErrors(refusal.fields);
      setFormError(failure.created ? `${refusal.message} O conteúdo já foi criado: ao salvar de novo, só o que falta é enviado.` : refusal.message);
      // A refusal means the calendar behind the modal may be stale (the client was archived, another operator moved it).
      if (failure.created || (failure.reason instanceof HttpClientError && failure.reason.status !== undefined && failure.reason.status < 500)) {
        void queryClient.invalidateQueries({ queryKey: ['agency', agency.agencyId, 'contents', clientId] });
      }
    }
  });

  const busy = save.isPending;
  useEffect(() => { onBusyChange(busy); }, [busy, onBusyChange]);

  const edit = (patch: Partial<ContentFormValues>, field?: keyof ContentFieldErrors): void => {
    setForm((current) => ({ ...current, ...patch }));
    if (field !== undefined) setErrors((current) => ({ ...current, [field]: undefined }));
    setFormError(undefined);
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setFormError(undefined);
    const problems = validate(form);
    setErrors(problems);
    if (Object.keys(problems).length > 0) return;
    save.mutate();
  };

  const locked = saved !== null && (saved.media.length > 0 || saved.coverAssetId !== null);
  const note = !context.canEdit
    ? (context.archived ? 'Cliente arquivado: o conteúdo é só leitura.' : 'Você pode ver este conteúdo, mas não editar.')
    : closed ? 'Este conteúdo já foi publicado ou cancelado e não pode mais ser editado.' : undefined;
  const captionError = errors.caption;

  return <div className="content-modal">
    <ContentPreview values={form} handle={context.handle} />
    <form className="form-stack content-modal__form" onSubmit={onSubmit} noValidate>
      {saved !== null && <p className="content-modal__status"><span className="content-card__badge">{STATUS_LABELS[saved.status]}</span></p>}
      {note !== undefined && <p className="form-hint" role="note">{note}</p>}
      <div className="form-field">
        <label htmlFor={`${ids}-title`}>Título</label>
        <TextInput
          id={`${ids}-title`}
          value={form.title}
          disabled={busy || !writable}
          onChange={(event) => edit({ title: event.target.value }, 'title')}
          aria-invalid={errors.title !== undefined}
          aria-describedby={errors.title === undefined ? undefined : `${ids}-title-error`}
        />
        {errors.title !== undefined && <FieldMessage id={`${ids}-title-error`} role="alert">{errors.title}</FieldMessage>}
      </div>
      <Select
        label="Formato"
        value={form.format}
        options={FORMAT_OPTIONS}
        disabled={busy || !writable}
        onChange={(value) => {
          const format = FORMAT_OPTIONS.find((option) => option.value === value)?.value;
          if (format !== undefined) edit({ format, ...(hasCover(format) ? {} : { coverAssetId: null }) }, 'media');
        }}
      />
      <div className="content-modal__when">
        <div className="form-field">
          <label htmlFor={`${ids}-day`}>Data</label>
          <TextInput
            id={`${ids}-day`}
            type="date"
            value={form.publishOn}
            disabled={busy || !writable}
            onChange={(event) => edit({ publishOn: event.target.value }, 'publishOn')}
            aria-invalid={errors.publishOn !== undefined}
            aria-describedby={errors.publishOn === undefined ? undefined : `${ids}-day-error`}
          />
          {errors.publishOn !== undefined && <FieldMessage id={`${ids}-day-error`} role="alert">{errors.publishOn}</FieldMessage>}
        </div>
        <div className="form-field">
          <label htmlFor={`${ids}-time`}>Hora</label>
          <TextInput
            id={`${ids}-time`}
            type="time"
            value={form.publishAtTime}
            disabled={busy || !writable}
            onChange={(event) => edit({ publishAtTime: event.target.value }, 'publishAtTime')}
            aria-invalid={errors.publishAtTime !== undefined}
            aria-describedby={errors.publishAtTime === undefined ? undefined : `${ids}-time-error`}
          />
          {errors.publishAtTime !== undefined && <FieldMessage id={`${ids}-time-error`} role="alert">{errors.publishAtTime}</FieldMessage>}
        </div>
      </div>
      <FolderField
        clientId={clientId}
        value={form.folderId}
        locked={locked}
        disabled={busy || !writable}
        canCreate={context.canEdit}
        error={errors.folderId}
        onChange={(folderId) => edit({ folderId, mediaAssetIds: [], coverAssetId: null }, 'folderId')}
      />
      {saved === null
        ? <p className="form-hint">A mídia e a capa se escolhem da pasta; escolha-as agora ou depois de criar o conteúdo.</p>
        : null}
      <MediaField
        clientId={clientId}
        folderId={form.folderId}
        format={form.format}
        selected={form.mediaAssetIds}
        disabled={busy || !writable}
        error={errors.media}
        onChange={(mediaAssetIds) => edit({ mediaAssetIds }, 'media')}
      />
      {hasCover(form.format) && <CoverField
        clientId={clientId}
        folderId={form.folderId}
        value={form.coverAssetId}
        disabled={busy || !writable}
        error={errors.cover}
        onChange={(coverAssetId) => edit({ coverAssetId }, 'cover')}
      />}
      <div className="form-field">
        <label htmlFor={`${ids}-caption`}>Legenda</label>
        <Textarea
          id={`${ids}-caption`}
          rows={6}
          value={form.caption}
          disabled={busy || !writable}
          onChange={(event) => edit({ caption: event.target.value }, 'caption')}
          aria-invalid={captionError !== undefined}
          aria-describedby={`${ids}-caption-count${captionError === undefined ? '' : ` ${ids}-caption-error`}`}
        />
        <p id={`${ids}-caption-count`} className="form-hint content-modal__counter">{captionCounter(form.caption)}</p>
        {captionError !== undefined && <FieldMessage id={`${ids}-caption-error`} role="alert">{captionError}</FieldMessage>}
      </div>
      {approvalWarning && <p className="form-hint" role="status">
        Este conteúdo está aprovado. Mudar a legenda, a mídia, a capa ou o formato o devolve para “Aguardando aprovação”.
      </p>}
      {formError !== undefined && <FieldMessage role="alert">{formError}</FieldMessage>}
      <div className="form-actions">
        {writable && <Button type="submit" loading={busy} disabled={busy || !dirty}>{saved === null ? 'Criar conteúdo' : 'Salvar'}</Button>}
        <Button variant="ghost" disabled={busy} onClick={onDone}>{writable ? 'Cancelar' : 'Fechar'}</Button>
      </div>
      {/* #266: the conversation of the content goes here, at the end of the tab. */}
    </form>
  </div>;
}

/** The modal around the editor: the tabs (Atribuição, #265, has its place and stays closed) and a close that waits for a write. */
function ContentDialog({ title, onClose, busy, children }: {
  title: string;
  onClose: () => void;
  busy: boolean;
  children: ReactNode;
}) {
  // Closing in the middle of a write would leave its success to close whatever is open by then.
  return <Modal title={title} closeLabel="Fechar conteúdo" onClose={() => { if (!busy) onClose(); }}>
    <div className="content-modal__tabs" role="tablist" aria-label="Seções do conteúdo">
      <Button role="tab" aria-selected="true" variant="secondary">Geral</Button>
      <Button role="tab" aria-selected="false" disabled variant="ghost">Atribuição</Button>
    </div>
    <div role="tabpanel" aria-label="Geral">{children}</div>
  </Modal>;
}

/** `/agencia/:agenciaId/conteudos/:clienteId/:conteudoId`: one content, read when it is opened and edited in place. */
export function ContentModalRoute() {
  const httpClient = useApiClient();
  const agency = useAgencyContext();
  const context = useOutletContext<ContentsOutletContext>();
  const { conteudoId = '' } = useParams();
  const close = useCloseTo(context.clientId);
  const [busy, setBusy] = useState(false);
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

  return <ContentDialog title={data?.title ?? 'Conteúdo'} onClose={close} busy={busy}>
    {hidden
      ? <div className="form-stack" role="alert">
        <p>Este conteúdo não existe mais ou você não tem acesso a ele.</p>
        <div className="form-actions"><Button variant="secondary" onClick={close}>Fechar</Button></div>
      </div>
      : content.isError
        ? <div className="form-stack" role="alert">
          <p>Não foi possível carregar o conteúdo. Tente de novo.</p>
          <div className="form-actions">
            <Button onClick={() => { void content.refetch(); }}>Tentar de novo</Button>
            <Button variant="secondary" onClick={close}>Fechar</Button>
          </div>
        </div>
        : data === undefined || !context.ready
          ? <div className="content-modal__loading" aria-hidden="true"><Skeleton /><Skeleton /><Skeleton /></div>
          : <ContentEditor key={data.id} context={context} initial={data} initialDay={data.publishOn} onBusyChange={setBusy} onDone={close} />}
  </ContentDialog>;
}

/** `/agencia/:agenciaId/conteudos/:clienteId/novo?dia=AAAA-MM-DD`: a new content, born in production on the day of the "+" or today. */
export function ContentCreateRoute() {
  const context = useOutletContext<ContentsOutletContext>();
  const [searchParams] = useSearchParams();
  const close = useCloseTo(context.clientId);
  const [busy, setBusy] = useState(false);
  const day = CalendarDaySchema.safeParse(searchParams.get('dia'));
  return <ContentDialog title="Novo conteúdo" onClose={close} busy={busy}>
    {!context.ready
      ? <div className="content-modal__loading" aria-hidden="true"><Skeleton /><Skeleton /><Skeleton /></div>
      : context.canEdit
      ? <ContentEditor context={context} initial={null} initialDay={day.success ? day.data : todayInSaoPaulo()} onBusyChange={setBusy} onDone={close} />
      : <div className="form-stack" role="alert">
        <p>{context.archived ? 'Este cliente está arquivado: não recebe conteúdo novo.' : 'Você não tem permissão para criar conteúdos.'}</p>
        <div className="form-actions"><Button variant="secondary" onClick={close}>Fechar</Button></div>
      </div>}
  </ContentDialog>;
}
