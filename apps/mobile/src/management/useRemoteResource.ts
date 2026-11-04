import { useCallback, useEffect, useRef, useState } from 'react';

export function useRemoteResource<T>(load: (signal: AbortSignal) => Promise<T>) {
  const [data, setData] = useState<T>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const controller = useRef<AbortController | undefined>(undefined);
  const mounted = useRef(true);
  const pending = useRef(false);
  const loadRef = useRef(load);
  loadRef.current = load;
  const refresh = useCallback(async () => {
    controller.current?.abort();
    const next = new AbortController(); controller.current = next;
    if (mounted.current) setLoading(true);
    try {
      const result = await loadRef.current(next.signal);
      if (mounted.current && !next.signal.aborted) setData(result);
    } catch (cause) {
      if (next.signal.aborted) return;
      if (mounted.current) setError(cause instanceof Error ? cause.message : 'Não foi possível carregar.');
      throw cause;
    } finally { if (mounted.current && controller.current === next) setLoading(false); }
  }, []);
  useEffect(() => {
    mounted.current = true; setLoading(true); setError(''); setData(undefined);
    void refresh().catch(() => {});
    return () => { mounted.current = false; controller.current?.abort(); };
  }, [refresh, load]);
  async function run(action: () => Promise<void>, message = 'Alterações salvas.') {
    if (pending.current) return false;
    pending.current = true; setBusy(true); setError(''); setNotice('');
    let saved = false;
    try {
      await action(); saved = true;
      if (mounted.current) { setNotice(message); await refresh(); }
      return true;
    } catch (cause) {
      if (mounted.current) setError(saved ? 'A alteração foi salva, mas não foi possível atualizar a tela. Atualize antes de repetir a ação.' : cause instanceof Error ? cause.message : 'Não foi possível concluir.');
      return saved;
    } finally { pending.current = false; if (mounted.current) setBusy(false); }
  }
  return { data, loading, busy, error, notice, run, refresh, setError };
}
