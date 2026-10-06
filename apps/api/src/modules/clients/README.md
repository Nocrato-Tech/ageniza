# Módulo `clients` (issues #124 e #125)

Cadastrar, ler, editar e listar os clientes da agência. As rotas do módulo ficam sob
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

## Detalhe e resumo

`GET` devolve o cadastro completo mais o resumo da aba Geral: `brandStudyFilled` (0 a 7, com
`personas` contando quando há ao menos uma ativa), `threadsAwaitingAgency`, `threadsAnsweredByAgency`
e `activePortalMembers`.

A definição de thread aberta, "aguardando a agência" e "com resposta da agência" vive **uma vez só**
em `thread-state.ts`, exportada: é o mesmo critério que a listagem (#125), o portal (#129) e as
rotas de conversa devem importar, para a contagem não divergir entre telas.

`photoUrl` é uma URL assinada do armazenamento de identidade, ou `null`. Chave ausente ou
irrecusável vira `null` com `log.warn`, sem derrubar a resposta -- nunca uma chave crua.

## Carteira (#125)

`GET /agencies/:agencyId/clients` devolve `{ data, meta }` com o contrato de paginação global
(`packages/contracts/src/pagination.ts`): 20 por página por padrão, teto de 100 que **limita** sem
recusar, e `page` gigante que vira 400 em vez de 500. A query é estrita: parâmetro que a SPEC não
declara é 400.

- **Ordem.** `sort=attention` (padrão): cliente com ao menos uma thread aguardando a agência vem
  primeiro, depois nome ascendente (sem diferenciar maiúsculas nem acento), com `id` como desempate
  para a paginação ser estável. `sort=name:asc` é só o nome.
- **Busca.** `search` casa com nome, razão social e `instagram_handle`, sem diferenciar maiúsculas
  nem acento: `normalize(..., NFD)` decompõe, um `regexp_replace` tira as marcas U+0300–U+036F e o
  `lower()` final é ASCII, então a dobra cobre maiúsculas e entrada NFD e não depende do locale do
  banco. `%` e `_` são escapados para a busca ser literal, e um `@` inicial, que a caixa de busca
  sugere, é descartado na comparação com o handle, que é gravado sem ele. O banco não tem
  `unaccent`; a expressão em `service.ts` é a mesma dos dois lados, coluna e termo.
- **`threadsAwaitingAgency`** sai da definição única de `thread-state.ts`, numa subconsulta por
  cliente que o índice `client_thread_comments (thread_id, created_at)` da #122 atende.
- **`pendingInvitations`** conta só convite de portal pendente (`client_invite`, não usado, não
  revogado, não expirado) numa CTE materializada, agrupada por `client_id` e filtrada pela agência:
  a contagem acontece **uma vez por página**, não uma subconsulta correlacionada por cliente, e o
  custo não cresce com os convites das outras agências. **Só é computada** para quem tem
  `cliente.convidar_usuario`; para os demais o campo é **omitido**, nunca zero.

## O que ficou de fora

- Foto (`#126`), arquivar/reativar e encerramento (`#131`).
- O restante do módulo (estudo de marca, personas, conversas, acessos) e o portal do cliente.
