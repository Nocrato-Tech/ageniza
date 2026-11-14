import { useEffect, useRef, useState } from 'react';
import { Mic, Square } from 'lucide-react';

import { Button, LiveStatus } from '@ageniza/ui';

import { AUDIO_ACCEPT, baseType, pickRecorderType, recordingFileName } from './portal-material-upload-model.js';

type Phase = 'idle' | 'asking' | 'recording' | 'recorded';

const clock = (seconds: number): string => `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;

const recorderType = (): string | undefined =>
  typeof MediaRecorder === 'undefined' || typeof navigator === 'undefined' || navigator.mediaDevices?.getUserMedia === undefined
    ? undefined
    : pickRecorderType((type) => MediaRecorder.isTypeSupported(type));

interface Take { readonly file: File; readonly url: string }

/**
 * Records a testimony from the microphone and hands the file over only when the person chooses to send it: ask for the microphone,
 * record, stop, listen, send. A browser that records no type the contract accepts is offered a file to choose instead.
 */
export function TestimonyRecorder({ busy, onSend }: { busy: boolean; onSend: (files: File[]) => void }) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [elapsed, setElapsed] = useState(0);
  const [take, setTake] = useState<Take | undefined>();
  const [problem, setProblem] = useState<string | undefined>();
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const fileInput = useRef<HTMLInputElement>(null);
  const type = recorderType();

  const release = (): void => {
    window.clearInterval(timer.current);
    stream.current?.getTracks().forEach((track) => { track.stop(); });
    stream.current = null;
  };
  useEffect(() => () => {
    release();
    if (recorder.current?.state === 'recording') recorder.current.stop();
  }, []);
  useEffect(() => () => { if (take !== undefined) URL.revokeObjectURL(take.url); }, [take]);

  const start = async (): Promise<void> => {
    if (type === undefined) return;
    setProblem(undefined);
    setTake(undefined);
    setPhase('asking');
    let media: MediaStream;
    try {
      media = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (error: unknown) {
      const denied = error instanceof DOMException && (error.name === 'NotAllowedError' || error.name === 'SecurityError');
      setProblem(denied
        ? 'Sem acesso ao microfone. Libere o microfone nas permissões do navegador e tente de novo, ou escolha um arquivo de áudio.'
        : 'Não encontramos um microfone. Conecte um e tente de novo, ou escolha um arquivo de áudio.');
      setPhase('idle');
      return;
    }
    stream.current = media;
    const chunks: Blob[] = [];
    const next = new MediaRecorder(media, { mimeType: type });
    next.ondataavailable = (event) => { if (event.data.size > 0) chunks.push(event.data); };
    next.onstop = () => {
      release();
      const mime = baseType(next.mimeType || type);
      const blob = new Blob(chunks, { type: mime });
      if (blob.size === 0) {
        setProblem('Não captamos áudio. Tente gravar de novo.');
        setPhase('idle');
        return;
      }
      const file = new File([blob], recordingFileName(mime, new Date()), { type: mime });
      setTake({ file, url: URL.createObjectURL(file) });
      setPhase('recorded');
    };
    recorder.current = next;
    next.start();
    setElapsed(0);
    timer.current = window.setInterval(() => { setElapsed((seconds) => seconds + 1); }, 1000);
    setPhase('recording');
  };

  const stop = (): void => { if (recorder.current?.state === 'recording') recorder.current.stop(); };

  const choose = (list: FileList | null): void => {
    const files = list === null ? [] : Array.from(list);
    if (fileInput.current !== null) fileInput.current.value = '';
    if (files.length > 0) onSend(files);
  };

  return <div className="portal-upload__recorder">
    {type === undefined && <p className="portal-upload__note">Este navegador não grava áudio. Escolha um arquivo de áudio do seu aparelho.</p>}
    {type !== undefined && phase === 'idle' && <Button leadingIcon={<Mic />} disabled={busy} onClick={() => { void start(); }}>Gravar depoimento</Button>}
    {phase === 'asking' && <p className="portal-upload__note">Permita o uso do microfone para começar a gravar.</p>}
    {phase === 'recording' && <div className="portal-upload__recording">
      <span className="portal-upload__dot" aria-hidden="true" />
      <span className="portal-upload__clock" role="timer" aria-label="Tempo gravado">{clock(elapsed)}</span>
      <Button variant="secondary" leadingIcon={<Square />} onClick={stop}>Parar</Button>
    </div>}
    {phase === 'recorded' && take !== undefined && <div className="portal-upload__take">
      <audio controls src={take.url} aria-label="Ouvir o depoimento gravado" />
      <div className="portal-upload__row">
        <Button loading={busy} onClick={() => { onSend([take.file]); setTake(undefined); setPhase('idle'); }}>Enviar depoimento</Button>
        <Button variant="ghost" disabled={busy} onClick={() => { setTake(undefined); setPhase('idle'); }}>Gravar de novo</Button>
      </div>
    </div>}
    <LiveStatus className="portal-upload__live">{phase === 'recording' ? 'Gravando.' : phase === 'recorded' ? 'Gravação pronta para ouvir e enviar.' : ''}</LiveStatus>
    {problem !== undefined && <p className="portal-upload__error" role="alert">{problem}</p>}
    {(phase === 'idle' || type === undefined) && <>
      <input ref={fileInput} type="file" accept={AUDIO_ACCEPT} hidden aria-label="Escolher um arquivo de áudio" onChange={(event) => { choose(event.target.files); }} />
      <Button variant="ghost" disabled={busy} onClick={() => fileInput.current?.click()}>Escolher um arquivo de áudio</Button>
    </>}
  </div>;
}
