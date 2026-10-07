# Módulo `clients` (issues #124, #125, #126, #127, #128 e #130)

Cadastrar, ler, editar e listar os clientes da agência, mais o estudo de marca, as personas e a
conversa em thread com o cliente (as rotas dela estão na seção "Conversa", abaixo).
Todas as rotas sob `requireSession` e `requireAgencyAccess`, com a permissão nomeada que a policy
de RLS da tabela também exige:

| método | rota | permissão |
|---|---|---|
| `GET` | `/agencies/:agencyId/clients` | `cliente.visualizar` |
| `POST` | `/agencies/:agencyId/clients` | `cliente.cadastrar` |
| `GET` | `/agencies/:agencyId/clients/:clientId` | `cliente.visualizar` |
| `PATCH` | `/agencies/:agencyId/clients/:clientId` | `cliente.operar` |
| `PUT` | `/agencies/:agencyId/clients/:clientId/photo` | `cliente.operar` |
| `DELETE` | `/agencies/:agencyId/clients/:clientId/photo` | `cliente.operar` |
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

## Foto (issue #126)

`PUT .../photo` recebe `{ imageBase64 }` (JSON, o transporte que a #100 escolheu para todo ativo de
identidade) e devolve `{ photoUrl }`; `DELETE .../photo` devolve `204`. O objeto vive no
armazenamento de identidade, nunca em `media_assets`, e **não entra em quota de agência**.

- **Tipo pelo conteúdo.** `uploadIdentityImage` lê os magic bytes; não há `contentType` no contrato
  e o corpo é `.strict()`, então um rótulo declarado é 400. SVG, HTML e bytes desconhecidos são 415,
  imagem acima do teto é 413, e **nada é gravado** em nenhum dos casos.
- **Tamanho antes do corpo.** A rota declara o próprio `bodyLimit` (`policy.ts`): o parser do
  Fastify recusa com 413 antes de qualquer handler ler o corpo. O limite global não foi aumentado.
- **A chave vem só de ids do servidor**: `agencies/<agencyId>/clients/<clientId>/avatar/<uuid>.<ext>`,
  com `agencyId` da rota autorizada e `clientId` validado como UUID (inválido é 404, como no resto
  do módulo). Nada do corpo, da query ou do cabeçalho entra na chave.
- **Cliente arquivado ou inexistente** é checado **antes** do envio ao bucket (409 `CLIENT_ARCHIVED`
  ou o 404 indistinto). Se o arquivamento acontecer entre a checagem e o commit, o objeto recém
  gravado é removido e a resposta é a mesma.
- **Protocolo da #100.** O objeto novo é gravado, a referência é confirmada sob `select ... for
  update` na linha do cliente, e só então o anterior é apagado. O lock serializa trocas
  concorrentes (sem ele sobra objeto órfão). Falha ao confirmar apaga o objeto novo.
- **Só se apaga o que é do cliente.** `photo_key` é dado numa tabela: antes de apagar o objeto
  anterior a rota confere que a chave ainda está no diretório do próprio cliente
  (`isClientAvatarKey`). Uma referência que aponte para outro cliente ou outra agência é registrada
  em `warn` e **não** apagada.
- **Teto por usuário** (`CLIENT_PHOTO_RATE_LIMIT`, 30 por minuto): o armazenamento de identidade
  não tem quota, então o teto segue a conta. Mesmo número da foto de perfil.
- As leituras (detalhe, resposta do `PATCH`) assinam a referência com a mesma validade; o bucket
  nunca é público.

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

## Conversa (#128 agência, #130 portal)

Os dois lados chamam o **mesmo serviço** (`conversation-service.ts`); o que muda é o
`ConversationScope` que cada conjunto de rotas monta da própria guarda. O lado de uma thread ou de
um comentário **nunca** vem do corpo (todo corpo é `.strict()`, então `side` é 400): é `agency` nas
rotas da agência e `client` nas do portal, e a RLS confere o par lado e credencial. Contratos em
`packages/contracts/src/conversations.ts`; as rotas em `conversation-routes.ts`.

| método | rota | quem |
|---|---|---|
| `GET` | `/agencies/:agencyId/clients/:clientId/threads` | `cliente.visualizar` |
| `POST` | `/agencies/:agencyId/clients/:clientId/threads` | `cliente.operar` |
| `GET` | `…/threads/:threadId/comments` | `cliente.visualizar` |
| `POST` | `…/threads/:threadId/comments` | `cliente.operar` |
| `POST` | `…/threads/:threadId/resolve` | `cliente.operar` |
| `GET` | `/clients/:clientId/threads` | vínculo ativo de cliente |
| `POST` | `/clients/:clientId/threads` | vínculo ativo de cliente |
| `GET` | `/clients/:clientId/threads/:threadId/comments` | vínculo ativo de cliente |
| `POST` | `/clients/:clientId/threads/:threadId/comments` | vínculo ativo de cliente |

As do portal usam `requireSession` e `requireClientAccess`, sem permissão do catálogo. **Não existe
`resolve` no portal** (só a agência resolve), nem rota de editar, apagar ou reabrir de nenhum lado.

- **Estado derivado**, de `thread-state.ts`: resolvida só enquanto `resolved_at` é posterior ao último
  comentário. Comentar numa thread resolvida a reabre; `resolvedBy` e `resolvedAt` só vêm preenchidos
  enquanto ela está resolvida, e resolver de novo não escreve nada.
- **Listagem**: o assunto é obrigatório e é exatamente um, `sectionKey` ou `personaId` (os dois, ou
  nenhum, é 400). 20 threads por página, a de atividade mais recente primeiro com `id` de desempate;
  50 comentários por página, o mais antigo primeiro. O total sai de `count(*) over ()`, no
  mesmo snapshot da página.
- **404 indistinto**: cliente de outra agência, thread de outro cliente, persona de outro cliente e
  id malformado respondem o mesmo 404. No portal a persona arquivada também, e isso é um filtro da
  rota, não só da RLS: o **colaborador que também tem vínculo de cliente** atravessa a policy pelo
  ramo de membro da agência, então toda regra do portal vale por filtro explícito (persona ativa,
  cliente da URL, vínculo e cliente ativos na guarda). Pelo portal essa pessoa age só como cliente,
  com qualquer papel na agência; cada rota do portal tem teste com ela.
- **409**: `CLIENT_ARCHIVED` (cliente arquivado é só leitura), `PERSONA_ARCHIVED` (a agência abrindo,
  comentando ou resolvendo em persona arquivada) e `SECTION_NOT_FILLED` (o portal abrindo thread em
  seção que a agência não preencheu; a agência não tem essa restrição). A checagem vem **antes** da
  escrita; se o estado muda entre a checagem e a escrita, a recusa da RLS é relida numa transação
  nova e dá o mesmo 409 (404 no portal, que só sabe que o que via sumiu).
- **Autor**: nome e foto saem de `app_private.thread_comment_authors`, a função `security definer`
  que lê o vínculo do lado do comentário e só responde a quem lê a thread (decisão
  `2026-10-07-autor-do-comentario-pelo-vinculo`). `author` é `null` quando o lado do comentário não
  tem vínculo de onde ler o nome, como o dono da agência sem linha de vínculo. A mesma função devolve
  quem resolveu a thread, pelo vínculo de agência, então `resolvedBy.name` existe mesmo quando quem
  resolveu nunca comentou (e só é `null` nesse mesmo caso do dono). A conversa nunca lê
  `auth."user"` por id.
- **Texto do comentário**: aparado, não vazio, até 5.000 bytes UTF-8 (o teto da coluna).

## O que ficou de fora

- Arquivar/reativar e encerramento (`#131`).
- A foto no portal (`#129`): a rota ainda não existe; ao nascer, deve assinar `photo_key` do mesmo
  jeito que o detalhe e a listagem.
- Acessos ao portal e o portal do cliente (telas).
