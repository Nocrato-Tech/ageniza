import { Button } from '@ageniza/ui';
import { useEffect, useRef, useState } from 'react';
import { useApiClient } from '../http.js';

const paths = ['/health', '/ready', '/auth/providers'] as const;
type Result = { url: string; status: number; elapsed: number; receivedAt: string; body: string };

export function LiveApiPanel() {
  const client = useApiClient();
  const [result, setResult] = useState<Result>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const active = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => { active.current?.abort(); active.current = undefined; }, []);

  async function execute(path: typeof paths[number]) {
    if (active.current) return;
    const controller = new AbortController();
    active.current = controller;
    setBusy(true); setError(''); setResult(undefined);
    const started = performance.now();
    const url = client.browserUrl(path);
    const timeout = window.setTimeout(() => controller.abort(), 12_000);
    try {
      const response = await fetch(url, { method: 'GET', credentials: 'omit', cache: 'no-store', redirect: 'error', headers: { Accept: 'application/json' }, signal: controller.signal });
      const text = await response.text();
      let body = text;
      try { body = JSON.stringify(JSON.parse(text), null, 2); } catch { /* Show non-JSON responses as text. */ }
      if (!controller.signal.aborted) setResult({ url, status: response.status, elapsed: Math.round(performance.now() - started), receivedAt: new Date().toLocaleTimeString('pt-BR'), body });
    } catch {
      if (active.current === controller) setError(controller.signal.aborted ? 'A consulta excedeu o tempo limite. Execute novamente.' : 'Não foi possível consultar a API. Confira a conexão e execute novamente.');
    } finally {
      window.clearTimeout(timeout);
      if (active.current === controller) { active.current = undefined; setBusy(false); }
    }
  }

  return <section id="api-live" className="mdocs-live" aria-labelledby="api-live-title">
    <h2 id="api-live-title">API em execução</h2>
    <p>Execute uma consulta pública no servidor deste ambiente. O resultado abaixo vem da API real.</p>
    <div className="mdocs-live__actions">{paths.map(path => <Button key={path} variant="secondary" size="sm" disabled={busy} onClick={() => void execute(path)}>Executar GET {path}</Button>)}</div>
    <p className="mdocs-live__note">Somente leitura, sem cookies ou dados de conta. As rotas autenticadas continuam exigindo sessão e permissões.</p>
    <div aria-live="polite" aria-busy={busy}>
      {busy && <p>Consultando o servidor…</p>}
      {error && <p role="alert">{error}</p>}
      {result && <><p><span className={`mdocs-status mdocs-status--${Math.floor(result.status / 100)}xx`}>HTTP {result.status}</span> · {result.elapsed} ms · Recebida do servidor às {result.receivedAt}</p><p><code>GET {result.url}</code></p><div className="mdocs-code"><pre tabIndex={0} aria-label="Resposta real da API"><code>{result.body || 'Resposta sem corpo.'}</code></pre></div></>}
      {!busy && !error && !result && <p>Nenhuma consulta executada. Escolha uma das rotas acima.</p>}
    </div>
  </section>;
}

