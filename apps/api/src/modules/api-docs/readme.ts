import {
  API_DOCUMENT_INFO,
  COMMON_ERRORS,
  DOCUMENTED_ROUTES,
  ERROR_MESSAGES,
  MODULE_DESCRIPTIONS,
  type ApiModule,
  type DocumentedRoute
} from './catalog.js';

const jsonBlock = (value: unknown): string => `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;

const errorList = (route: DocumentedRoute): string => {
  if (route.errors.length === 0) return 'Nenhum.';
  return [...route.errors]
    .sort((a, b) => a.status - b.status || a.code.localeCompare(b.code))
    .map((error) => `\`${error.status} ${error.code}\``)
    .join(' · ');
};

const routeSection = (route: DocumentedRoute): string => {
  const lines: string[] = [
    `#### \`${route.method.toUpperCase()} ${route.path}\``,
    '',
    route.summary + '.',
    '',
    `- Acesso: ${route.access}.`,
    `- Permissão: ${route.permission === null ? '—' : `\`${route.permission}\``}.`
  ];
  if (route.requestExample !== undefined) {
    lines.push('', '**Requisição** (`application/json`):', '', jsonBlock(route.requestExample));
  }
  for (const response of route.responses) {
    lines.push('', `**Resposta \`${response.status}\`** — ${response.description}`);
    if (response.example !== undefined) lines.push('', jsonBlock(response.example));
  }
  lines.push('', `**Erros:** ${errorList(route)}`, '');
  return lines.join('\n');
};

const moduleSection = (module: ApiModule): string => {
  const routes = DOCUMENTED_ROUTES.filter((route) => route.module === module);
  const table = [
    '| método | rota | acesso | permissão | o que faz |',
    '|---|---|---|---|---|',
    ...routes.map((route) => `| \`${route.method.toUpperCase()}\` | \`${route.path}\` | ${route.access} | ${route.permission === null ? '—' : `\`${route.permission}\``} | ${route.summary} |`)
  ].join('\n');
  return [
    `### ${module} — ${MODULE_DESCRIPTIONS[module]}`,
    '',
    table,
    '',
    ...routes.map(routeSection)
  ].join('\n');
};

/**
 * Renders the human summary committed at `docs/api/README.md`. Generated from the same catalog as
 * the OpenAPI document, so the table, the permission column and the examples cannot drift from it.
 */
export const renderApiSummary = (): string => {
  const modules = Object.keys(MODULE_DESCRIPTIONS) as ApiModule[];
  return [
    '# API do Ageniza — referência',
    '',
    `> Gerado por \`pnpm api:docs\` a partir dos schemas de \`packages/contracts\`. Não edite à mão.`,
    `> Documento OpenAPI 3.1: [\`openapi.json\`](./openapi.json).`,
    '',
    `Em desenvolvimento (\`pnpm dev\`) a interface interativa fica em <http://127.0.0.1:3001/docs>.`,
    'Fora de desenvolvimento a rota **não existe**: o inventário da API não é publicado sem necessidade.',
    '',
    '## Como a API autentica',
    '',
    'A sessão é um cookie httpOnly, `SameSite=lax`, emitido por `POST /auth/login`; não há token no',
    'corpo nem na URL. Cada requisição de tenant informa na própria rota em qual agência ou cliente',
    'está atuando (`/agencies/:agencyId/...`, `/clients/:clientId/...`), e a guarda revalida o',
    'vínculo a cada chamada. Agência inexistente, suspensa ou fora do alcance devolve **404**',
    'indistinto, nunca 403: a existência não é confirmada.',
    '',
    '## Formato de erro',
    '',
    jsonBlock({
      error: { code: 'NOT_FOUND', message: 'Agency not found.' },
      meta: { requestId: 'req-de-exemplo' }
    }),
    '',
    `Cada rota lista os erros que pode devolver, incluindo os globais: qualquer uma pode responder`,
    `\`${COMMON_ERRORS.internal.status} ${COMMON_ERRORS.internal.code}\`, as de escrita também \`${COMMON_ERRORS.csrf.status} ${COMMON_ERRORS.csrf.code}\`, e as que`,
    `recebem corpo \`${COMMON_ERRORS.payloadTooLarge.status} ${COMMON_ERRORS.payloadTooLarge.code}\`. As mensagens em português são as que o`,
    'produto mostra; as demais são internas.',
    '',
    '## Rotas por módulo',
    '',
    ...modules.map(moduleSection),
    '## Catálogo de códigos de erro',
    '',
    '| código | mensagem padrão |',
    '|---|---|',
    ...Object.entries(ERROR_MESSAGES).map(([code, message]) => `| \`${code}\` | ${message} |`),
    ''
  ].join('\n');
};

export const API_DOCUMENT_TITLE = API_DOCUMENT_INFO.title;
