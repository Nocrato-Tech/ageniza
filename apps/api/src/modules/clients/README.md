# Módulo `clients` (issues #124, #125, #126, #127, #128, #129, #130, #131 e #132)

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

As quatro rotas de encerrar, arquivar e reativar o cliente têm a sua seção, abaixo.

O `POST` aceita `{ name }` e, opcional, `city`. O `PATCH` aceita qualquer subconjunto dos campos de cadastro da
seção 3 da SPEC, e `null` limpa um campo. Contratos em `packages/contracts/src/clients.ts`.

`city` (decisão `2026-11-11`) é uma linha de até 80 caracteres, aparada, sem quebra de linha nem caractere
invisível; vazio vira `null`. O limite e a regra de texto estão também no banco (`clients_city_check`,
`app_private.display_text_valid`), e `created_at` sai no detalhe como "cliente desde".

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

Para quem é Owner ou tem `conteudo.visualizar` o resumo traz também as abas e "quem trabalha neste cliente"
(decisão `2026-11-11`); para os demais os campos são **omitidos, não zerados**, e nada disso é consultado:

- `contentsThisMonth`: conteúdos do cliente com `publish_on` no mês corrente de America/Sao_Paulo, sem os cancelados.
  `mediaFiles`: arquivos confirmados e não removidos. `mediaFolders`: as pastas do cliente, as padrão inclusive.
  Tudo por SQL daqui (`loadClientTabCounts`): o módulo não importa os de mídia e de conteúdo.
- `workers`/`workersMore`: as pessoas responsáveis pelos conteúdos **abertos** do cliente (os estados da definição única de
  conteúdo aberto), a com mais conteúdos primeiro e depois por nome, no máximo cinco, e `workersMore` diz quantas ficaram
  de fora. Derivado do dono do conteúdo, nunca atribuído. Cada uma vem como `membershipId` (o vínculo ativo com **esta**
  agência), nome e foto assinada; nunca o e-mail nem o id da conta. Dono sem vínculo não aparece.

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
  cliente que o índice `client_thread_comments (thread_id, created_at)` da #122 atende. Conta só
  conversa do estudo de marca (sem conteúdo e sem pedido de material): a conversa de um conteúdo e o pedido ficam fora, aqui, no
  resumo do detalhe e no Início do portal (decisão de 2026-10-11, a das rotas de conversa do cliente).
- **`contentIndicators`** (`pending`, `inReview`, `overdue`, `adjusting`, `dueSoon`) vem de uma CTE materializada sobre
  `contents`, agrupada por cliente e filtrada pela agência, **uma vez por página**. Pendente é em
  produção ou em ajuste; em revisão é aguardando aprovação; atrasado é a data planejada anterior ao dia de
  hoje em São Paulo (`app_private.sao_paulo_date` sobre o instante `asOf` que a rota passa), sem
  publicado nem cancelado. `adjusting` é só o em ajuste (já contado em `pending`) e `dueSoon` é a data
  planejada de hoje a dois dias à frente, os dois extremos dentro. A definição de atrasado e de prazo em dois dias é uma só
  (`contentDeadline`, em `packages/contracts`), escrita em SQL por `contentDeadlineSql` (`modules/contents/deadline-sql.ts`) e
  presa à função por um teste de paridade (#549). **Só é computada** para quem tem `conteudo.visualizar` (ou é Owner): para os
  demais o campo é **omitido**, nunca zero, e a ordem não muda. Na ordem `attention`, para quem a recebe,
  "tem atraso" é o primeiro critério, antes de "tem sugestão aguardando"; `name:asc` não muda
  (decisão de 2026-10-11).
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
- A persona tem ainda o perfil (decisão `2026-11-11`), todo opcional no `POST` e no `PATCH`: `age` (inteiro de 1 a 120),
  `occupation` e `location` (uma linha, até 80), `traits` (até 5 de até 24, cada uma uma linha visível; `[]` limpa),
  `whereTheyAre` e `toneThatWorks` (até 280, podem quebrar linha). Texto vazio vira `null`. Os limites estão também nas
  CHECK da tabela, e o gatilho que trava a persona arquivada lista as seis colunas novas.
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
| `GET` | `/agencies/:agencyId/clients/:clientId/threads` | `cliente.visualizar` (conteúdo: `conteudo.visualizar`) |
| `POST` | `/agencies/:agencyId/clients/:clientId/threads` | `cliente.operar` (conteúdo: `conteudo.operar` e `conteudo.visualizar`) |
| `GET` | `…/threads/:threadId/comments` | `cliente.visualizar` (conteúdo: `conteudo.visualizar`) |
| `POST` | `…/threads/:threadId/comments` | `cliente.operar` (conteúdo: `conteudo.operar` e `conteudo.visualizar`) |
| `POST` | `…/threads/:threadId/resolve` | `cliente.operar` (conteúdo: `conteudo.operar` e `conteudo.visualizar`) |
| `GET` | `/clients/:clientId/threads` | vínculo ativo de cliente |
| `POST` | `/clients/:clientId/threads` | vínculo ativo de cliente |
| `GET` | `/clients/:clientId/threads/:threadId/comments` | vínculo ativo de cliente |
| `POST` | `/clients/:clientId/threads/:threadId/comments` | vínculo ativo de cliente |

As do portal usam `requireSession` e `requireClientAccess`, sem permissão do catálogo. **Não existe
`resolve` no portal** (só a agência resolve), nem rota de editar, apagar ou reabrir de nenhum lado.

- **Estado derivado**, de `thread-state.ts`: resolvida só enquanto `resolved_at` é posterior ao último
  comentário. Comentar numa thread resolvida a reabre; `resolvedBy` e `resolvedAt` só vêm preenchidos
  enquanto ela está resolvida, e resolver de novo não escreve nada.
- **Listagem**: o assunto é obrigatório e é exatamente um, `sectionKey`, `personaId` ou `contentId`
  (dois, ou nenhum, é 400). 20 threads por página, a de atividade mais recente primeiro com `id` de desempate;
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
- **Texto do comentário**: aparado, não vazio, até 5.000 bytes UTF-8 (o teto da coluna). Recusa
  controle (C0 e C1, menos tabulação e quebra de linha), separador de linha e de parágrafo, todo
  `Default_Ignorable_Code_Point` que não é `Cf` (CGJ, seletores de variação, preenchimentos de Hangul),
  o espaço em branco do Braille e a cabeça de nota nula (U+1D159); a exceção é um U+FE0F logo depois de
  um pictograma. Um texto só de espaços e caracteres de formato é vazio. Caractere de formato dentro de
  um texto com letras (a junção de um emoji de família) passa.

### A conversa de um conteúdo (#259)

As mesmas rotas aceitam `contentId` como assunto (`{ subject: { contentId }, body }` e
`?contentId=`), com **uma conversa por conteúdo**. A decisão
`2026-10-11-conversa-do-conteudo-nas-rotas-de-conversa-do-cliente` tem o porquê de cada ponto.

- **Abrir é achar ou criar**: a segunda abertura, de qualquer lado, comenta na conversa que já existe
  (`201`, a mesma `thread.id`). O índice único decide a corrida: `INSERT ... ON CONFLICT DO NOTHING`, e
  quem espera lê a conversa do outro. Nunca duas conversas, nunca `23505`.
- **A permissão é a do assunto**: ler pede `conteudo.visualizar`; abrir, comentar e resolver pedem
  `conteudo.operar` **e** `conteudo.visualizar`, e não `cliente.operar`. A guarda da rota deixa passar
  quem tem uma das duas famílias e `conversation-service.ts` (`agencyPermissions`) exige a do assunto:
  o estudo de marca continua com `cliente.*`. Sem a leitura do conteúdo, agir pelo id de uma conversa
  é `404` (a policy a esconde) e listar ou abrir pelo `contentId` é `403`.
- **Estados**: a agência pode abrir e comentar em produção; com o conteúdo cancelado recebe `409 CONTENT_NOT_OPEN` ao abrir
  ou comentar, e continua lendo e resolvendo. Comentários em produção ficam visíveis ao portal quando o conteúdo é disponibilizado. O portal recebe `404` em toda rota fora de "aguardando
  aprovação", "em ajuste", "aprovado" e "publicado", por `app_private.content_open_to_client` no SQL do
  lado cliente (a pessoa que também é colaboradora leria, pelo ramo da agência, o conteúdo em produção).
- **404 indistinto**: conteúdo de outro cliente (mesmo de um cliente que a mesma pessoa tem vínculo),
  de outra agência ou inexistente. O conteúdo é lido dentro do cliente da rota; sem isso, a chave
  estrangeira composta viraria `500`.
- **Erros do banco**: `A0020` dá `409 CLIENT_ARCHIVED` (agência) ou `404` (portal); `42501` é relido
  numa transação nova; `40P01` e `40001` dão `409 TRY_AGAIN`.
- **Contadores**: o selo "sugestões aguardando", o resumo da aba Geral e o Início do portal contam só a
  conversa do estudo de marca (`brandStudyThreadSql`, em `thread-state.ts`: sem conteúdo e sem pedido de material).

### O pedido de material (decisão `2026-11-10-estrutural-pedido-de-material-e-assunto-proprio-da-conversa-do-cliente`)

Um assunto a mais da conversa do cliente, `{ materialRequest: true }`, com **título** obrigatório (`title`, uma linha de até
80 caracteres, aparada) e prazo opcional (`dueOn`). Não há rota de
abertura própria: é a mesma `POST …/threads`, porque o pedido é uma conversa (primeiro comentário, estado derivado,
resolver, reabrir por comentário) e uma rota paralela repetiria essas regras.

- **Só a agência abre.** O corpo do portal é `PortalCreateThreadRequestSchema`, que não conhece `materialRequest` nem
  `dueOn` (`400`). Atrás dele está o banco (`client_threads_material_request_agency_check`): se uma escrita do lado
  cliente chegar lá, a rota responde `403`, nunca `500`.
- **O prazo** vai no `INSERT` de toda abertura, de propósito: quem recusa `dueOn` fora do pedido é a constraint
  `client_threads_due_on_check` (`400` no campo `dueOn`), e quem recusa a data fora de hoje a 90 dias em São Paulo é a
  função `A0120` (`400` no campo `dueOn`). `materialRequestDatabaseRefusal` lê os três erros; o schema do corpo só
  antecipa os dois primeiros.
- **O título** vai no `INSERT` e é só do pedido: `title` em outro assunto é `400`, e `title` ausente ou em branco num pedido
  também (`client_threads_title_request_check` e `client_threads_title_check` no banco; o `INSERT` é a única escrita, a
  coluna não tem `UPDATE`). A conversa antiga e a de outro assunto têm `title` `null`.
- **O portal não sabe quem da agência abriu ou respondeu** (decisão `2026-11-11`, item 4): num pedido de material, o
  `openedBy.name` e o `resolvedBy.name` voltam `null` e o comentário da agência vem com `author: null`, na leitura e na
  resposta do `POST`. A agência vê os nomes de sempre.
- **Permissão**: a do estudo de marca (`cliente.visualizar` para ler, `cliente.operar` para abrir, comentar e resolver).
  A guarda da rota ainda deixa passar quem tem `conteudo.*`; o serviço (`agencyPermissions`) e a RLS seguram o resto.
- **`GET /clients/:clientId/material-requests`** (portal): os pedidos **abertos** do cliente da rota, com o primeiro
  comentário (`body`), `dueOn` e `createdAt`, o prazo mais próximo primeiro. O filtro por `client_id` está no SQL
  (`listOpenMaterialRequests`) porque a policy deixa a pessoa com vários vínculos, e a colaboradora com vínculo, ler os
  pedidos de todos os clientes. "Aberto" é o estado derivado de sempre (`openThreadSql`): o pedido resolvido sai da lista
  e um comentário do cliente o traz de volta. A lista e a contagem do item "Pedidos da agência" do portal
  (`home.materialRequestsOpen`) saem da mesma definição (`OPEN_MATERIAL_REQUESTS_FROM`, em `thread-state.ts`), para o
  número e a página dizerem o mesmo.
- **Decisão de 2026-11-07 intacta**: o pedido não tem conteúdo, então nada que o portal lê aqui é a conversa de um
  conteúdo em produção; o filtro de `loadThreadContext` para conteúdo segue valendo nas rotas de comentário.

## Leituras do portal (#129)

| método | rota | quem |
|---|---|---|
| `GET` | `/clients/:clientId` | vínculo ativo de cliente |
| `GET` | `/clients/:clientId/brand-study` | vínculo ativo de cliente |

`requireSession` e `requireClientAccess`, sem permissão do catálogo, em `portal-routes.ts` e
`portal-service.ts`. O cliente é sempre o que a guarda provou (`request.clientContext`), nunca um valor
da requisição, e nenhuma consulta daqui lê `auth."user"`: o portal não mostra pessoa nestas rotas.

- **Cadastro**: os mesmos campos do detalhe da agência (a cidade e o "cliente desde" inclusive), somente leitura, com a foto assinada do mesmo
  jeito, o `agencyName` do cabeçalho do portal e `onboardingSeenAt` **do vínculo de quem chama**, lido
  por id de vínculo (outra pessoa do mesmo cliente tem outro valor). `status` e `archivedAt` são
  fixados em `active` e `null` pelo contrato.
- **`home`**: `threadsAnsweredByAgency` conta threads abertas cujo último comentário é da agência,
  **deste cliente** e **só as que o portal lê** (a de persona arquivada fica de fora); `brandStudyFilled`
  usa a definição única de `service.ts`. Quando a agência responde o número sobe; um comentário novo do
  cliente o faz cair. `contentsAwaitingApproval` conta os conteúdos do **próprio cliente** em "aguardando
  aprovação", por `app_private.portal_contents`: a policy de `contents` responde só à agência, e a função
  é a regra só do portal (vínculo ativo com o cliente, nunca rascunho), então a pessoa do portal puro, a
  pessoa dupla (`dual`, `dualBare`) e a cruzada (`crossDual`) veem o mesmo número. A conversa de um
  conteúdo não entra em `threadsAnsweredByAgency`.
- **Estudo**: as sete seções sempre, só as personas `active`, sem `updatedBy` (a consulta nem seleciona
  `updated_by`). `updatedAt` fica.
- **A RLS não diz por qual lado**: o colaborador que também tem vínculo de cliente lê a persona
  arquivada e as threads de todos os clientes da agência pelo ramo de membro, então persona ativa, cliente
  da rota e vínculo próprio são condições do SQL. Cada rota tem teste com ele (`dual`), com o de papel sem
  nenhuma chave `cliente.*` (`dualBare`) e com o de uma agência que tem vínculo com cliente de outra.
- **404 indistinto** (a guarda): outro cliente, cliente de outra agência, cliente arquivado, agência
  suspensa, vínculo removido, colaborador sem vínculo (Owner inclusive), id malformado ou ausente.

Decisão: `2026-10-07-portal-le-o-cadastro-inteiro-e-o-inicio-conta-so-o-que-o`.

## Acessos ao portal, pela agência (#132, #711)

| método | rota | permissão |
|---|---|---|
| `GET` | `/agencies/:agencyId/clients/:clientId/members` | `cliente.convidar_usuario` |
| `POST` | `/agencies/:agencyId/clients/:clientId/members` ("Adicionar pessoa") | `cliente.convidar_usuario` |
| `POST` | `…/members/:accessId/remove` | `cliente.remover_usuario` |
| `POST` | `…/members/:accessId/reactivate` | `cliente.remover_usuario` |
| `POST` | `…/members/:accessId/resend` ("Reenviar e-mail") | `cliente.convidar_usuario` |
| `POST` | `…/invitations/:invitationId/resend` ("Reenviar" do convite antigo) | `cliente.convidar_usuario` |
| `GET` | `/agencies/:agencyId/clients/:clientId/invitations` | `cliente.convidar_usuario` |

Em `access-routes.ts` e `access-service.ts`. Cancelar convite é a rota do módulo `invitations` (`convite.cancelar`); o
convite de portal deixou de ser criado, e o reenvio dele é a rota `…/invitations/:invitationId/resend` deste módulo, que o
transforma em acesso (decisão `2026-10-27-acessos-pendentes-podem-ser-reenviados-e-removidos`). A rota de reenviar
convite do módulo `invitations` segue respondendo `409 PORTAL_INVITATION_DISCONTINUED` para convite de portal.

**Uma pessoa é um acesso dado a um e-mail** (`client_portal_accesses`, decisão
`2026-10-26-estrutural-o-acesso-ao-portal-e-por-e-mail-e-a-conta-e-opcional`), com conta ou sem ela. A aplicação
não escreve na tabela: cada rota chama a função de banco do seu efeito, e o estado de `client_memberships` acompanha o do
acesso (`2026-10-27-o-estado-do-membership-do-portal-acompanha-o-acesso`). O acesso passa à conta no login, quando uma
conta com aquele e-mail verificado carrega os contextos (`app_private.link_client_portal_accesses`, chamada por
`listValidContexts`), e **nunca** em "Adicionar pessoa".

- **Pessoas**: 20 por página, por nome (o e-mail, enquanto a pessoa não entrou) sem diferenciar maiúsculas nem acento,
  comparado byte a byte (`collate "C"`) com o id do acesso de desempate; `status=active` (padrão) ou `removed`. Item:
  `accessId`, `name` (o nome que a agência digitou, ou nulo, até a conta entrar no portal **daquele cliente**; depois, o nome da conta; a mesma expressão
  decide o nome mostrado e a ordem), `email` (como foi gravado), `status`, `entered` ("ainda não entrou com a conta"
  quando `false`; só vira `true` na primeira entrada no portal do cliente, e não no vínculo), `lastEnteredAt` e `since`.
  `lastEnteredAt` é `last_entered_at` (decisão `2026-11-10-estrutural-ultimo-acesso-ao-portal-por-cliente`), lido pela mesma
  policy da lista e gravado só pelo banco; ele **pode vir preenchido com `entered: false`**, para quem só abriu o link de
  aprovação (decisão `2026-11-10-quem-so-abriu-o-link-de-aprovacao-ainda-nao-entrou-com-a-conta`), e `entered` continua sendo
  o que libera o reenvio. A consulta parte de `client_portal_accesses` filtrado pelo cliente e pela agência e chega em
  `auth."user"` só pelo `user_id` do acesso, num `LEFT JOIN`. **Nada na lista diz se um e-mail tem conta**: o nome digitado
  vale até a primeira entrada, a conta existir ou não, e depois da entrada a conta já é conhecida de quem convidou
  (decisão `2026-11-11`, que revisa a de `2026-10-27` sobre o nome nunca vir da conta antes da entrada).
- **Adicionar pessoa**: o e-mail e, opcional, `name`, o nome que a agência digita para reconhecer a pessoa (uma linha de até
  120 caracteres, aparada; vazio é sem nome). O nome fica **no acesso**, nunca na conta: reativar um acesso removido o troca
  quando um nome vem (sem nome o antigo fica) e um acesso já ativo não grava nada. Dá o acesso na hora, sem conta e sem aceite, e manda o e-mail de boas-vindas
  ("Entrar no portal"). O mesmo e-mail de novo reativa a mesma linha (`409 ACCESS_EXISTS` se já estava ativo). Se a conta
  que tinha o endereço já trocou de e-mail, ela é solta e as sessões dela terminam
  (`2026-10-27-adicionar-pessoa-de-novo-solta-a-conta-que-trocou-de-e-mail`). O e-mail de boas-vindas conta no limite diário
  de e-mails da agência, no mesmo orçamento dos convites (`429 DAILY_EMAIL_LIMIT`), e agência em somente leitura recusa
  adicionar e reativar (`409 AGENCY_READ_ONLY`); remover continua livre.
- **Reenviar e-mail** (`…/members/:accessId/resend`): para o acesso **ativo que ainda não entrou**. Chama
  `app_private.resend_client_portal_access`, que confere `cliente.convidar_usuario`, o plano (`409 AGENCY_READ_ONLY`), o estado
  do acesso (`409 ACCESS_NOT_PENDING` se removido ou se a pessoa já entrou), o minuto da pessoa (`429 RESEND_TOO_SOON`, proposta
  pendente de validação) e o limite diário (`429 DAILY_EMAIL_LIMIT`, mesma trava dos convites), e grava o evento
  `client_member.resent`, que a contagem diária lê. Não muda o acesso, a geração nem os links de aprovação. O e-mail sai
  depois do commit; a falha dele é `502 EMAIL_DELIVERY_FAILED` com o lugar já gasto. A rota confere antes que o acesso é
  **daquele cliente** (`404`), porque a função só conhece a agência.
- **Reenviar convite antigo** (`…/invitations/:invitationId/resend`): chama `app_private.convert_client_portal_invitation`, que
  dá o acesso do endereço como Adicionar pessoa (`add_client_portal_access`) e revoga o convite, na mesma transação, travando
  o acesso antes do convite (a ordem da remoção). Quem aceitou ou cancelou o convite no meio ganha, e o acesso recém-dado
  volta com o rollback (`409 INVITATION_NOT_PENDING`). Endereço que já tem acesso ativo: `409 ACCESS_EXISTS`, nada gravado, o
  convite fica. Se a conta que tinha o endereço já trocou de e-mail, as sessões dela terminam, como em Adicionar pessoa.
- **Convites**: 20 por página, o que expira primeiro no topo (`id` de desempate), só
  `purpose = 'client_invite'` **daquele cliente**, não aceitos, não revogados e não expirados. A policy
  `invitations_select` deixa quem tem `cliente.convidar_usuario` ler convite de colaborador também
  (`docs/business/structural-changes.md`, "Permissões de convite compartilhadas entre tipos"); o filtro
  é da consulta e um teste prova que convite de colaborador, de ativação e de outro cliente não saem.
- **Remover e reativar** chamam `app_private.remove_client_portal_access` e `reactivate_client_portal_access`. A rota
  confere antes que o cliente é da agência e não está arquivado (`409`) e que o acesso é **daquele cliente** (`404`);
  a pessoa perde ou recupera o acesso na requisição seguinte, e só deste cliente. Remover avança a geração do acesso (o
  que mata os links de aprovação dele), tira o membership junto e, quando há conta, encerra as sessões dela; reativar não
  devolve a geração. Repetir a operação é idempotente: a função diz se escreveu, e só a remoção que escreveu encerra sessão.
  Se a função recusar depois das checagens (cliente arquivado, acesso sumido ou permissão perdida no
  meio), a recusa é relida numa transação nova e dá o `409`, o `404` ou o `403` que a checagem teria dado.
- Cliente arquivado é só leitura: as duas listas respondem; remover e reativar, `409`.

Decisão: `2026-10-07-acessos-ao-portal-remover-e-reativar-pessoa-sao-idempotentes`.

## Encerrar o contrato, arquivar e reativar (#131; o job é a #133)

| método | rota | permissão |
|---|---|---|
| `PUT` | `/agencies/:agencyId/clients/:clientId/closing` | `cliente.arquivar` |
| `DELETE` | `/agencies/:agencyId/clients/:clientId/closing` | `cliente.arquivar` |
| `POST` | `/agencies/:agencyId/clients/:clientId/archive` | `cliente.arquivar` |
| `POST` | `/agencies/:agencyId/clients/:clientId/reactivate` | `cliente.arquivar` |

Em `lifecycle-routes.ts` e `lifecycle-service.ts`. `status`, `archived_at` e `closing_date` estão fora de
todo *grant* de `ageniza_app`: o único escritor são as funções `app_private.set_client_closing_date`,
`archive_client` e `reactivate_client`, que conferem `cliente.arquivar` na agência do próprio cliente
(a rota é a segunda barreira, não a primeira). O job diário chama `archive_due_client`, uma vez por cliente vencido, que faz o que
`archive_client` faz, então rota e job têm o mesmo efeito: portal fechado na
requisição seguinte, convites de portal pendentes revogados, vínculos preservados, `closing_date` limpa,
evento em `audit.events`. Todas respondem o cliente (`200`), no mesmo formato do `PATCH`.

- **Encerramento**: corpo `{ closingDate: 'YYYY-MM-DD' }`, dia que existe no calendário; "hoje ou depois"
  é a regra da função, em `America/Sao_Paulo` (`app_private.sao_paulo_date`), e ontem é `400` com
  `details.issues[0].path = closingDate`. Hoje é aceito e o cliente segue `active`, com o portal aberto: o
  job só arquiva `closing_date` anterior a hoje. Agendar de novo troca a data. O `PATCH` do cadastro não
  alcança a coluna (`.strict()` na rota, sem *grant* no banco).
- **Desmarcar** (`DELETE`): sem encerramento agendado é `409 CLOSING_DATE_NOT_SET`.
- **Arquivar** sem pré-condição; cliente já arquivado é `409 CLIENT_ARCHIVED`, e nas outras três rotas
  também (a única ação de um cliente arquivado é reativar).
- **Reativar**: cliente ativo é `409 CLIENT_NOT_ARCHIVED`; nome em uso entre os ativos (a função compara
  como o índice único: sem maiúsculas, com espaços internos e NBSP normalizados) é `409
  CLIENT_NAME_IN_USE` e o cliente segue arquivado. Os convites revogados no arquivamento não voltam, e as
  pessoas com vínculo entram de novo sem convite.
- **Disputa com convite do mesmo cliente**: reenviar um convite trava a linha dele e depois o cliente;
  arquivar trava o cliente e depois os convites. Duas transações reais podem se cruzar (`40P01`) e uma
  perde. A rota que perde responde `409 TRY_AGAIN`, sem detalhe do banco e sem nada gravado, e repetir
  funciona; o reenvio já fazia o mesmo (#335).
- **Convite criado ou reenviado enquanto o cliente é arquivado**: o gatilho da `20261006000400` trava o cliente e,
  achando-o arquivado depois da espera, levanta `A0020`. As duas rotas de convite (`invitations/routes.ts`) o
  traduzem para `409 CLIENT_ARCHIVED` e nada é criado; antes era `500`.
- **Escrita nas filhas enquanto o cliente é arquivado** (#392): o mesmo gatilho vale para seção do estudo,
  persona, conversa e comentário. O `A0020` vira `409 CLIENT_ARCHIVED` na agência (`PUT` de seção, `POST` de
  persona, de conversa e de comentário) e `404 NOT_FOUND` no portal, onde cliente arquivado é sempre "não
  encontrado". Nada é gravado. Editar o que já existe (persona, seção já preenchida) não trava o cliente e
  não levanta `A0020`.
- O `404` é um só para cliente inexistente, de outra agência ou com id que não é UUID. Se a função
  recusar depois das checagens (permissão perdida no meio, cliente arquivado no meio), a recusa é relida
  numa transação nova e vira o `403`, o `404` ou o `409` que a checagem teria dado.

Decisões: `2026-10-07-a-data-de-encerramento-do-cliente-vem-de-uma-funcao-pura-do-fuso` e
`2026-10-07-encerrar-arquivar-e-reativar-cliente-o-que-a-rota-recusa-e-como-responde`.

## O que ficou de fora

- A aba Geral e as ações no detalhe (telas).
- O portal do cliente e a aba Acessos (telas).
