import { useEffect, useRef, useState } from 'react';
import type { Asset, Repository, UploadProgress } from './types';
type UploadFile = Parameters<Repository['upload']>[2];
export function useUploadTransfer(repository: Repository) {
  const [progress, setProgress] = useState<UploadProgress>();
  const [working, setWorking] = useState(false);
  const retained = useRef<{ clientId: string; folderId: string; file: UploadFile } | undefined>(undefined);
  const controller = useRef<AbortController | undefined>(undefined);
  const phase = useRef<UploadProgress['phase'] | undefined>(undefined);
  const mounted = useRef(true);
  const generation = useRef(0);
  useEffect(() => {
    generation.current += 1; mounted.current = true; controller.current = undefined; retained.current = undefined; phase.current = undefined;
    setProgress(undefined); setWorking(false);
    return () => { generation.current += 1; mounted.current = false; if (phase.current !== 'confirming') controller.current?.abort(); retained.current = undefined; };
  }, [repository]);
  async function transfer(clientId: string, folderId: string, file: UploadFile): Promise<Asset | undefined> {
    if (controller.current) return;
    const epoch = generation.current;
    let confirming = false;
    retained.current = { clientId, folderId, file }; const next = new AbortController(); controller.current = next; phase.current = 'preparing';
    const active = () => mounted.current && generation.current === epoch && controller.current === next;
    if (active()) { setWorking(true); setProgress(undefined); }
    try {
      const asset = await repository.upload(clientId, folderId, file, (state) => { if (state.phase === 'confirming') confirming = true; if (!active()) return; phase.current = state.phase; if (state.phase === 'ready' || state.retryable === false) retained.current = undefined; setProgress(state); }, next.signal);
      if (!active()) return;
      retained.current = undefined; return asset;
    } catch (error) { if (!active() || next.signal.aborted && !confirming) return; throw error; }
    finally { if (active()) { controller.current = undefined; setWorking(false); } }
  }
  function cancel() { if (phase.current === 'preparing' || phase.current === 'sending') controller.current?.abort(); }
  return { progress, working, transfer, cancel, matches: (clientId: string, folderId: string) => retained.current?.clientId === clientId && retained.current?.folderId === folderId, canRetry: !!retained.current && !working && progress?.retryable === true, retry: () => { const value = retained.current; return value ? transfer(value.clientId, value.folderId, value.file) : Promise.resolve(undefined); } };
}
