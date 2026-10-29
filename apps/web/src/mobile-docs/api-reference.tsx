import { Button, Field, Pill, TextInput } from '@ageniza/ui';
import { Check, Copy } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';

import { InlineMarkdown } from './markdown.js';
import { buildReference, searchOperations, type ApiReferenceModel, type OperationView, type OpenApiDocument } from './openapi.js';
import openapiSource from '../../../../docs/api/openapi.json?raw';

let reference: ApiReferenceModel | undefined;

/** The file is parsed once, when the tab is first opened: it weighs close to 1 MB. */
export const getReference = (): ApiReferenceModel => (reference ??= buildReference(JSON.parse(openapiSource) as OpenApiDocument));

const OPERATION_HASH = '#op-';
const statusClass = (status: string): string => `mdocs-status mdocs-status--${status.slice(0, 1)}xx`;
const json = (value: unknown): string => JSON.stringify(value, null, 2);

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="secondary"
      size="sm"
      leadingIcon={copied ? <Check /> : <Copy />}
      onClick={() => {
        void navigator.clipboard.writeText(text).then(
          () => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 2000);
          },
          () => undefined
        );
      }}
    >
      {copied ? 'Copiado' : 'Copiar'}
    </Button>
  );
}

function CodeBlock({ label, code }: { label: string; code: string }) {
  return (
    <div className="mdocs-code">
      <div className="mdocs-code__bar"><span>{label}</span><CopyButton text={code} /></div>
      <pre tabIndex={0} aria-label={`Código — ${label}`}><code>{code}</code></pre>
    </div>
  );
}

function OperationBody({ operation }: { operation: OperationView }) {
  return (
    <div className="mdocs-op__body">
      <div className="mdocs-op__text"><InlineMarkdown source={operation.description} /></div>
      <p className="mdocs-op__permission">
        {operation.permissions.length === 0
          ? <>Permissão: <span>nenhuma além do acesso descrito acima</span></>
          : <>{operation.permissions.length === 1 ? 'Permissão: ' : 'Uma destas permissões: '}{operation.permissions.map((permission, index) => <span key={permission}>{index > 0 && ' ou '}<code>{permission}</code></span>)}</>}
      </p>

      {operation.parameters.length > 0 && (
        <section aria-label="Parâmetros">
          <h4>Parâmetros</h4>
          <div className="mdocs-table"><table>
            <thead><tr><th scope="col">Nome</th><th scope="col">Onde</th><th scope="col">Tipo</th><th scope="col">Obrigatório</th></tr></thead>
            <tbody>{operation.parameters.map((parameter) => (
              <tr key={`${parameter.in}-${parameter.name}`}>
                <th scope="row"><code>{parameter.name}</code></th>
                <td>{{ path: 'rota', query: 'query', header: 'cabeçalho' }[parameter.in]}</td>
                <td>{[parameter.schema?.type, parameter.schema?.format].filter(Boolean).join(' · ')}{parameter.schema?.enum ? ` (${parameter.schema.enum.join(', ')})` : ''}</td>
                <td>{parameter.required === true ? 'sim' : 'não'}</td>
              </tr>
            ))}</tbody>
          </table></div>
        </section>
      )}

      {operation.hasRequestBody && (
        <section aria-label="Corpo da requisição">
          <h4>Corpo da requisição</h4>
          {operation.requestExample === undefined ? <p>JSON; o formato está em <code>packages/contracts</code>.</p> : <CodeBlock label="Exemplo do corpo (JSON)" code={json(operation.requestExample)} />}
        </section>
      )}

      <section aria-label="Respostas">
        <h4>Respostas</h4>
        <ul className="mdocs-responses">
          {operation.responses.map((response) => (
            <li key={response.status}>
              <p><span className={statusClass(response.status)}>{response.status}</span> {response.description}</p>
              {response.example !== undefined && Object.keys(response.example as object).length > 0 && <CodeBlock label={`Exemplo da resposta ${response.status}`} code={json(response.example)} />}
            </li>
          ))}
        </ul>
      </section>

      <section aria-label="Exemplo com fetch">
        <h4>Exemplo com fetch</h4>
        <CodeBlock label="Exemplo com fetch" code={operation.fetchExample} />
      </section>
    </div>
  );
}

function Operation({ operation, openByDefault }: { operation: OperationView; openByDefault: boolean }) {
  const [open, setOpen] = useState(openByDefault);
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (openByDefault) ref.current?.scrollIntoView?.({ block: 'start' });
  }, [openByDefault]);

  return (
    <details ref={ref} id={`op-${operation.id}`} className="mdocs-op" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>
        <span className={`mdocs-method mdocs-method--${operation.method}`}>{operation.method.toUpperCase()}</span>
        <code className="mdocs-op__path">{operation.path}</code>
        <span className="mdocs-op__summary">{operation.summary}</span>
        {operation.permissions.map((permission) => <Pill key={permission} className="mdocs-op__pill">{permission}</Pill>)}
      </summary>
      {open && <OperationBody operation={operation} />}
    </details>
  );
}

/** The tab "Referência da API": every route of `docs/api/openapi.json`, by tag, with a search and a `fetch` call per route. */
export function ApiReference() {
  const model = getReference();
  const [query, setQuery] = useState('');
  const { hash } = useLocation();
  const groups = useMemo(() => searchOperations(model.groups, query), [model, query]);
  const found = groups.reduce((total, group) => total + group.operations.length, 0);
  const target = hash.startsWith(OPERATION_HASH) ? hash.slice(OPERATION_HASH.length) : null;

  return (
    <>
      <aside className="mdocs-side" aria-label="Grupos de rotas">
        <ul>
          {groups.map((group) => (
            <li key={group.name}><a href={`#tag-${group.name}`}>{group.name}<span>{group.operations.length}</span></a></li>
          ))}
        </ul>
      </aside>
      <main id="mdocs-main" className="mdocs-main mdocs-main--wide" tabIndex={-1}>
        <header className="mdocs-api-head">
          <h1>Referência da API</h1>
          <p className="mdocs-lead">{model.title}, versão {model.version}. {model.operationCount} rotas, geradas de <code>docs/api/openapi.json</code>.</p>
          <div className="mdocs-op__text"><InlineMarkdown source={model.description} /></div>
          <Field label="Buscar rota ou texto" hint="Ex.: aprovar, /portal-approval, conteudo.operar, 409">
            {(control) => <TextInput {...control} type="search" value={query} onChange={(event) => setQuery(event.target.value)} autoComplete="off" />}
          </Field>
          <p role="status" className="mdocs-count">{query.trim() === '' ? `${model.operationCount} rotas` : `${found} de ${model.operationCount} rotas`}</p>
        </header>
        {found === 0 && <p className="mdocs-empty">Nenhuma rota encontrada. Tente o caminho (<code>/clients</code>), a permissão ou o código do erro.</p>}
        {groups.map((group) => (
          <section key={group.name} id={`tag-${group.name}`} className="mdocs-tag" aria-labelledby={`tag-${group.name}-title`}>
            <h2 id={`tag-${group.name}-title`}><code>{group.name}</code></h2>
            <p>{group.description}</p>
            {group.operations.map((operation) => <Operation key={operation.id} operation={operation} openByDefault={target === operation.id} />)}
          </section>
        ))}
      </main>
    </>
  );
}
