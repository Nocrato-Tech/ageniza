import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Check, CircleAlert, FileText, Image as ImageIcon, Music, RotateCcw, Upload, Video } from 'lucide-react';

import { Button, FieldMessage } from '@ageniza/ui';

import { useAgencyContext, useWriteBlocked } from './agency.js';
import { useApiClient } from './http.js';
import { foldersQueryKey, libraryQueryKey } from './media-library-model.js';
import { PlanLimitNotice } from './plan-limit.js';
import { UPLOAD_FAILURE_TEXT, UploadError, uploadMedia, type UploadFailure } from './media-upload.js';

type Phase = { readonly kind: 'idle' } | { readonly kind: 'sending' } | { readonly kind: 'failed'; readonly failure: UploadFailure } | { readonly kind: 'cancelled' } | { readonly kind: 'done' };

/** A failure that no retry with the same file can fix: the person must pick another file. */
const FILE_IS_THE_PROBLEM: ReadonlySet<UploadFailure> = new Set(['unsupported-type', 'too-large', 'empty', 'rejected']);

const SVG_TYPE = 'image/svg+xml';
const LIBRARY_ACCEPT = 'image/*,video/*,application/pdf,audio/*,.svg';

const kindOf = (file: File): ReactNode =>
  file.type.startsWith('video/') ? <Video /> : file.type === 'application/pdf' ? <FileText /> : file.type.startsWith('audio/') ? <Music /> : <ImageIcon />;

const percent = (sent: number, total: number): number => (total === 0 ? 0 : Math.min(100, Math.floor((sent / total) * 100)));

/**
 * Direct upload into the open folder: the chosen file stays on screen through progress, failure and retry, and leaves only
 * when the upload is confirmed or the person picks another one. The picker is the button; the native input behind it is
 * only what the browser opens, so the folder's empty state can open it too (`inputRef`) and hide the button (`triggerHidden`).
 * `library` is the client's library, which also takes a PDF, an audio and a logo (an SVG is accepted only as one); a content's picker does not.
 */
export function MediaUploader({ clientId, folderId, onUploaded, onSendingChange, sizeLabel, heading, inputRef, triggerHidden = false, library = false }: {
  clientId: string;
  folderId: string;
  /** The id of the media just confirmed, so a caller that wants it in a list can put it there. */
  onUploaded: (assetId: string) => void;
  /** Tells a caller whose form is open that a file is on its way. */
  onSendingChange?: ((sending: boolean) => void) | undefined;
  sizeLabel: (bytes: number) => string;
  heading?: ReactNode;
  inputRef: RefObject<HTMLInputElement | null>;
  triggerHidden?: boolean;
  library?: boolean;
}) {
  const agency = useAgencyContext();
  const blocked = useWriteBlocked();
  const httpClient = useApiClient();
  const queryClient = useQueryClient();
  const inputId = useId();
  const controller = useRef<AbortController | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [sent, setSent] = useState(0);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [asLogo, setAsLogo] = useState(false);

  useEffect(() => () => { controller.current?.abort(); }, []);
  // The folder is another place: what was chosen for the last one does not follow the person.
  useEffect(() => { controller.current?.abort(); controller.current = null; setFile(null); setPhase({ kind: 'idle' }); setSent(0); setAsLogo(false); }, [folderId]);

  const send = (chosen: File): void => {
    const own = new AbortController();
    controller.current = own;
    setSent(0);
    setPhase({ kind: 'sending' });
    uploadMedia({ httpClient, agencyId: agency.agencyId, clientId, folderId, file: chosen, asLogo: asLogo || chosen.type === SVG_TYPE, onProgress: setSent, signal: own.signal })
      .then((assetId) => {
        if (controller.current !== own) return;
        setFile(null);
        if (inputRef.current !== null) inputRef.current.value = '';
        setPhase({ kind: 'done' });
        void queryClient.invalidateQueries({ queryKey: ['agency', agency.agencyId, 'media-folder-assets', clientId, folderId] });
        void queryClient.invalidateQueries({ queryKey: libraryQueryKey(agency.agencyId, clientId) });
        void queryClient.invalidateQueries({ queryKey: foldersQueryKey(agency.agencyId, clientId) });
        onUploaded(assetId);
      })
      .catch((error: unknown) => {
        if (controller.current !== own) return;
        const failure = error instanceof UploadError ? error.failure : 'unknown';
        setPhase(failure === 'cancelled' ? { kind: 'cancelled' } : { kind: 'failed', failure });
      });
  };

  const sending = phase.kind === 'sending';
  useEffect(() => {
    onSendingChange?.(sending);
    return () => { onSendingChange?.(false); };
  }, [sending, onSendingChange]);
  const progress = file === null ? 0 : percent(sent, file.size);
  return <div className="media-uploader">
    {(heading !== undefined || !triggerHidden) && <div className="content-folders__heading">
      {heading}
      {!triggerHidden && <Button variant="secondary" leadingIcon={<Upload />} disabled={sending} blockedReason={blocked} onClick={() => inputRef.current?.click()}>Enviar mídia</Button>}
    </div>}
    <label htmlFor={inputId} className="visually-hidden">Enviar mídia</label>
    <input
      ref={inputRef}
      id={inputId}
      className="visually-hidden"
      type="file"
      accept={library ? LIBRARY_ACCEPT : 'image/*,video/*'}
      disabled={sending}
      tabIndex={-1}
      aria-hidden="true"
      onChange={(event) => {
        const chosen = event.target.files?.[0] ?? null;
        setFile(chosen);
        setAsLogo(false);
        setPhase({ kind: 'idle' });
        setSent(0);
      }}
    />
    {file !== null && <div className="media-uploader__file">
      <span className="media-uploader__kind" aria-hidden="true">{kindOf(file)}</span>
      <div className="media-uploader__text">
        <p className="media-uploader__name">{file.name} · {sizeLabel(file.size)}</p>
        {sending && <div className="media-uploader__meter">
          <progress className="media-uploader__progress" max={100} value={progress} aria-label={`Enviando ${file.name}`}>{progress}%</progress>
          <p className="media-uploader__percent" aria-hidden="true">{progress}%</p>
        </div>}
      </div>
      <div className="media-uploader__actions">
        {sending
          ? <Button variant="secondary" onClick={() => { controller.current?.abort(); }}>Cancelar envio</Button>
          : phase.kind === 'failed' && FILE_IS_THE_PROBLEM.has(phase.failure)
            ? null
            : phase.kind === 'failed'
              ? <Button variant="secondary" leadingIcon={<RotateCcw />} onClick={() => send(file)}>Tentar de novo</Button>
              : <Button variant="secondary" leadingIcon={<Upload />} onClick={() => send(file)}>Enviar</Button>}
      </div>
    </div>}
    {library && file !== null && file.type.startsWith('image/') && !sending && (file.type === SVG_TYPE
      ? <p className="media-uploader__logo">Um SVG é enviado como logo do cliente.</p>
      : <label className="media-uploader__logo"><input type="checkbox" checked={asLogo} onChange={(event) => setAsLogo(event.target.checked)} />Enviar como logo do cliente</label>)}
    {phase.kind === 'failed' && phase.failure === 'quota' && <PlanLimitNotice limit="storage" />}
    {phase.kind === 'failed' && phase.failure !== 'quota' && <FieldMessage role="alert"><CircleAlert size={16} aria-hidden="true" />{UPLOAD_FAILURE_TEXT[phase.failure]}</FieldMessage>}
    {phase.kind === 'cancelled' && <p className="media-uploader__done" role="status">{UPLOAD_FAILURE_TEXT.cancelled}</p>}
    {phase.kind === 'done' && <p className="media-uploader__done" role="status"><Check size={16} aria-hidden="true" />Mídia enviada.</p>}
  </div>;
}
