import { useEffect, useId, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import { Button, FieldMessage } from '@ageniza/ui';

import { useAgencyContext } from './agency.js';
import { useApiClient } from './http.js';
import { UPLOAD_FAILURE_TEXT, UploadError, uploadMedia, type UploadFailure } from './media-upload.js';

type Phase = { readonly kind: 'idle' } | { readonly kind: 'sending' } | { readonly kind: 'failed'; readonly failure: UploadFailure } | { readonly kind: 'cancelled' } | { readonly kind: 'done' };

/** A failure that no retry with the same file can fix: the person must pick another file. */
const FILE_IS_THE_PROBLEM: ReadonlySet<UploadFailure> = new Set(['unsupported-type', 'too-large', 'empty', 'rejected']);

const percent = (sent: number, total: number): number => (total === 0 ? 0 : Math.min(100, Math.floor((sent / total) * 100)));

/**
 * Direct upload into the open folder: the chosen file stays on screen through progress, failure and retry, and leaves only
 * when the upload is confirmed or the person picks another one.
 */
export function MediaUploader({ clientId, folderId, onUploaded, sizeLabel }: {
  clientId: string;
  folderId: string;
  onUploaded: () => void;
  sizeLabel: (bytes: number) => string;
}) {
  const agency = useAgencyContext();
  const httpClient = useApiClient();
  const queryClient = useQueryClient();
  const inputId = useId();
  const input = useRef<HTMLInputElement>(null);
  const controller = useRef<AbortController | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [sent, setSent] = useState(0);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });

  useEffect(() => () => { controller.current?.abort(); }, []);
  // The folder is another place: what was chosen for the last one does not follow the person.
  useEffect(() => { controller.current?.abort(); controller.current = null; setFile(null); setPhase({ kind: 'idle' }); setSent(0); }, [folderId]);

  const send = (chosen: File): void => {
    const own = new AbortController();
    controller.current = own;
    setSent(0);
    setPhase({ kind: 'sending' });
    uploadMedia({ httpClient, agencyId: agency.agencyId, clientId, folderId, file: chosen, onProgress: setSent, signal: own.signal })
      .then(() => {
        if (controller.current !== own) return;
        setFile(null);
        if (input.current !== null) input.current.value = '';
        setPhase({ kind: 'done' });
        void queryClient.invalidateQueries({ queryKey: ['agency', agency.agencyId, 'media-folder-assets', clientId, folderId] });
        onUploaded();
      })
      .catch((error: unknown) => {
        if (controller.current !== own) return;
        const failure = error instanceof UploadError ? error.failure : 'unknown';
        setPhase(failure === 'cancelled' ? { kind: 'cancelled' } : { kind: 'failed', failure });
      });
  };

  const sending = phase.kind === 'sending';
  const progress = file === null ? 0 : percent(sent, file.size);
  return <div className="media-uploader">
    <label htmlFor={inputId} className="media-uploader__label">Enviar mídia</label>
    <input
      ref={input}
      id={inputId}
      className="media-uploader__input"
      type="file"
      accept="image/*,video/*"
      disabled={sending}
      onChange={(event) => {
        const chosen = event.target.files?.[0] ?? null;
        setFile(chosen);
        setPhase({ kind: 'idle' });
        setSent(0);
      }}
    />
    {file !== null && <div className="media-uploader__file">
      <p className="media-uploader__name">{file.name} · {sizeLabel(file.size)}</p>
      {sending && <progress className="media-uploader__progress" max={100} value={progress} aria-label={`Enviando ${file.name}`}>{progress}%</progress>}
      {sending && <p className="media-uploader__percent" aria-hidden="true">{progress}%</p>}
      <div className="media-uploader__actions">
        {sending
          ? <Button variant="secondary" onClick={() => { controller.current?.abort(); }}>Cancelar envio</Button>
          : phase.kind === 'failed' && FILE_IS_THE_PROBLEM.has(phase.failure)
            ? null
            : <Button onClick={() => send(file)}>{phase.kind === 'failed' ? 'Tentar de novo' : 'Enviar'}</Button>}
      </div>
    </div>}
    {phase.kind === 'failed' && <FieldMessage role="alert">{UPLOAD_FAILURE_TEXT[phase.failure]}</FieldMessage>}
    {phase.kind === 'cancelled' && <p className="media-uploader__done" role="status">{UPLOAD_FAILURE_TEXT.cancelled}</p>}
    {phase.kind === 'done' && <p className="media-uploader__done" role="status">Mídia enviada.</p>}
  </div>;
}
