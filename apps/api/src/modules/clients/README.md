# Módulo `clients` (issues #124, #125 e #127)

Cadastrar, ler, editar e listar os clientes da agência, mais o estudo de marca e as personas.
Todas as rotas sob `requireSession` e `requireAgencyAccess`, com a permissão nomeada que a policy
de RLS da tabela também exige:

| método | rota | permissão |
|---|---|---|
| `GET` | `/agencies/:agencyId/clients` | `cliente.visualizar` |
| `POST` | `/agencies/:agencyId/clients` | `cliente.cadastrar` |
| `GET` | `/agencies/:agencyId/clients/:clientId` | `cliente.visualizar` |
| `PATCH` | `/agencies/:agencyId/clients/:clientId` | `cliente.operar` |
| `GET` | `/agencies/:agencyId/clients/:clientId/brand-study` | `cliente.visualizar` |
| `PUT` | `/agencies/:agencyId/clients/:clientId/brand-study/sections/:sectionKey` | `cliente.operar` |
| `POST` | `/agencies/:agencyId/clients/:clientId/personas` | `cliente.operar` |
| `PATCH` | `/agencies/:agencyId/clients/:clientId/personas/:personaId` | `cliente.operar` |
| `POST` | `/agencies/:agencyId/clients/:clientId/personas/:personaId/archive` | `cliente.operar` |
| `POST` | `/agencies/:agencyId/clients/:clientId/personas/:personaId/unarchive` | `cliente.operar` |

O `POST` aceita só `{ name }`. O `PATCH` aceita qualquer subconjunto dos campos de cadastro da
seção 3 da SPEC, e `null` limpa um campo. Contratos em `packages/contracts/src/clients.ts`.

Nome, razão social e contatos usam a regra compartilhada de nome de exibição
(`createDisplayNameSchema`, issue #200): recusam caractere de controle, invisível de formato e
override bidi, e exigem ao menos uma letra ou número -- um espaço de largura zero não cria
homônimo ativo visualmente idêntico. O `PATCH` exige ao menos um campo (corpo vazio é `400`), e
texto em branco vira `null` em vez de string vazia.

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

## Estudo de marca e personas (#127)

As **sete seções são fixas** e o `GET` sempre devolve todas, preenchidas ou não (seção 3 da SPEC);
não existe rota de criar seção. O `PUT` é um *upsert* cujo corpo depende da chave — texto para
`branding`, `tone_of_voice`, `positioning` e `observations`, até 24 `{ name, hex }` para `colors`,
um dos doze arquétipos para `archetype`; `personas` não aceita `PUT` (400). O arquétipo viaja em
inglês no contrato e é gravado com o rótulo em português, como o banco exige.

- Texto de seção é aparado, não pode ficar vazio (só espaços é 400) e limita a 20.000 bytes UTF-8,
  o mesmo teto da coluna.
- `updatedBy` é resolvido **pelo vínculo com a agência** (membro ou posse), nunca por
  `auth."user"` solto; a RLS ainda fixa `updated_by` no usuário da sessão no `INSERT` e no `UPDATE`.
- O `filled` (0 a 7) vem da mesma consulta do resumo do detalhe: `personas` conta quando há ao menos
  uma ativa, e o portal verá só as ativas — a agência vê as arquivadas também.
- Persona de outro cliente — da mesma agência ou não — é o mesmo `404`, e todo `:personaId`
  malformado também; o `PATCH`/`archive`/`unarchive` filtram por `client_id`.
- Cliente arquivado responde `409` em toda escrita, inclusive quando o arquivamento acontece entre
  a leitura e o `INSERT`/`UPDATE` (a violação de RLS `42501` vira o mesmo 409).

## O que ficou de fora

- Foto (`#126`), arquivar/reativar e encerramento (`#131`).
- Conversas em thread, acessos ao portal e o portal do cliente.
