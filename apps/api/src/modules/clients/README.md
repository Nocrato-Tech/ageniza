# Módulo `clients` (issue #124, listagem #125)

Cadastrar, ler, editar e **listar** os clientes da agência. As rotas da agência, sob
`requireSession` e `requireAgencyAccess`, com a permissão nomeada que a policy de RLS da tabela
também exige:

| método | rota | permissão |
|---|---|---|
| `GET` | `/agencies/:agencyId/clients` | `cliente.visualizar` |
| `POST` | `/agencies/:agencyId/clients` | `cliente.cadastrar` |
| `GET` | `/agencies/:agencyId/clients/:clientId` | `cliente.visualizar` |
| `PATCH` | `/agencies/:agencyId/clients/:clientId` | `cliente.operar` |

O `POST` aceita só `{ name }`. O `PATCH` aceita qualquer subconjunto dos campos de cadastro da
seção 3 da SPEC, e `null` limpa um campo. Contratos em `packages/contracts/src/clients.ts`.

## Regras que o banco não pode deixar só para a rota

- **Nome em uso** entre os ativos: a rota traduz a violação do índice `clients_active_name_unique`
  (código `23505`) em `409 CLIENT_NAME_IN_USE`, nunca por consulta prévia -- é o índice que decide,
  então dois `POST` simultâneos dão exatamente um `201` e um `409`.
- **Cliente arquivado** no `PATCH`: a RLS devolve **0 linhas** (a policy `clients_update` exige
  `status = 'active'`); a rota confirma que o cliente existe na agência e responde
  `409 CLIENT_ARCHIVED`. Cliente inexistente, de outra agência ou `:clientId` inválido é o mesmo
  `404`, sem distinguir.
- `created_at`, `status` e `updated_by` **nunca** vêm do corpo; `updated_by` é o usuário da sessão.

## Listagem (#125)

`GET /agencies/:agencyId/clients` devolve `{ data, meta }` no contrato de `pagination.ts`. Padrão de
20, teto global de 100. Parâmetros nomeados, e **só** eles: `page`, `pageSize`, `search` (nome,
razão social ou `instagram_handle`, sem diferenciar maiúsculas nem acento — nunca o CNPJ), `status`
(`active` padrão | `archived`) e `sort` (`attention` padrão | `name:asc`); parâmetro desconhecido é
400.

`sort=attention` põe os clientes com uma ou mais threads aguardando a agência primeiro, depois nome
ascendente, sempre com o `id` como desempate final para a paginação ser estável. A contagem por
cliente vem do `threadsAwaitingAgencyCountSql` de `thread-state.ts` — a mesma definição do resumo
do detalhe —, apoiada no índice `client_thread_comments (thread_id, created_at)`. `totalItems` é uma
segunda consulta de contagem simples, nunca a tabela inteira.

`pendingInvitations` é **omitido**, não zerado, para quem não tem `cliente.convidar_usuario` (ou
não é Owner): zero seria uma mentira que a interface mostraria. A busca sem acento usa a extensão
`unaccent` (`public.unaccent`), criada pela migration
`20260930150000_clients_listing_search_unaccent.mjs`.

O `:clientId` malformado continua sendo o mesmo 404 na rota de detalhe; a listagem não tem id de
cliente no caminho.

## Detalhe e resumo

`GET` devolve o cadastro completo mais o resumo da aba Geral: `brandStudyFilled` (0 a 7, com
`personas` contando quando há ao menos uma ativa), `threadsAwaitingAgency`, `threadsAnsweredByAgency`
e `activePortalMembers`.

`photoUrl` é uma URL assinada do armazenamento de identidade, ou `null`. Chave ausente ou
irrecusável vira `null` com `log.warn`, sem derrubar a resposta -- nunca uma chave crua.

## O que ficou de fora

- Foto (`#126`), arquivar/reativar e encerramento (`#131`).
- O restante do módulo (estudo de marca, personas, conversas, acessos) e o portal do cliente.
