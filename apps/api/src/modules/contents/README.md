# Módulo `contents` (issue #254)

O conteúdo de um cliente, do lado da agência: a **consulta por período** (calendário e feed), criar,
ler e editar, e mover de data (que é editar `publishOn`). Todas as rotas sob `requireSession` e
`requireAgencyAccess`; o cliente de `:clientId` precisa pertencer à agência do caminho, e o conteúdo,
ao cliente, senão o mesmo `404`.

| método | rota | permissão |
|---|---|---|
| `GET` | `/agencies/:agencyId/clients/:clientId/contents?from=&to=` | `conteudo.visualizar` |
| `GET` | `/agencies/:agencyId/clients/:clientId/contents/feed?cursor=` | `conteudo.visualizar` |
| `GET` | `/agencies/:agencyId/contents/activation` | `conteudo.visualizar` |
| `GET` | `/agencies/:agencyId/contents/awaiting-client` | `conteudo.visualizar` |
| `GET` | `/agencies/:agencyId/contents/summary` | `conteudo.visualizar` |
| `POST` | `/agencies/:agencyId/clients/:clientId/contents` | `conteudo.operar` e `conteudo.visualizar` |
| `POST` | `/agencies/:agencyId/clients/:clientId/contents/submit` | `conteudo.operar` e `conteudo.visualizar` |
| `GET` | `/agencies/:agencyId/clients/:clientId/contents/:contentId` | `conteudo.visualizar` |
| `PATCH` | `/agencies/:agencyId/clients/:clientId/contents/:contentId` | `conteudo.operar` e `conteudo.visualizar` |
| `POST` | `.../contents/:contentId/submit` | `conteudo.operar` e `conteudo.visualizar` |
| `POST` | `.../contents/:contentId/approve-by-agency` | `conteudo.aprovar_pela_agencia` e `conteudo.visualizar` |
| `POST` | `.../contents/:contentId/publish` | `conteudo.publicar` e `conteudo.visualizar` |
| `POST` | `.../contents/:contentId/unpublish` | `conteudo.publicar` e `conteudo.visualizar` |
| `POST` | `.../contents/:contentId/cancel` | `conteudo.cancelar` e `conteudo.visualizar` |
| `POST` | `.../contents/:contentId/reschedule` | `conteudo.operar` e `conteudo.visualizar` |
| `POST` | `.../contents/:contentId/tasks` | `conteudo.operar` e `conteudo.visualizar` |
| `PATCH` | `.../contents/:contentId/tasks/:taskId` | `conteudo.operar` e `conteudo.visualizar` |
| `POST` | `.../tasks/:taskId/deliver` | `conteudo.visualizar`; quem entrega é o responsável da subtarefa |
| `POST` | `.../tasks/:taskId/approve` | `conteudo.visualizar`; quem aprova é o responsável do conteúdo ou `conteudo.aprovar_pela_agencia` |
| `POST` | `.../tasks/:taskId/return` | o mesmo de aprovar, com o comentário |

Os contratos estão em `packages/contracts/src/contents.ts`; as decisões, em
`docs/business/decisions/2026-10-11-conteudo-*.md`, `2026-10-11-consulta-por-periodo-teto-de-500-itens-e-formato-da-resposta.md`,
`2026-10-11-transicoes-do-conteudo-na-api-corpo-dia-real-e-codigos.md` e
`2026-10-11-subtarefas-do-conteudo-na-api-resposta-guarda-e-limites-de-texto.md`. As pastas e os roteiros
são de outras issues e **não** estão aqui.

O portal do cliente (consulta por período, o que espera aprovação, o post, aprovar e pedir ajuste, issue #257; a URL assinada da mídia, #584) está em [`portal.md`](portal.md).

## A consulta por período

É o formato que Tarefas e Dashboard copiam. `from` e `to` são dias `AAAA-MM-DD` incluídos; até 93 dias
contando os dois extremos (93 passa, 94 é `400`); até 500 itens somando conteúdos e roteiros (acima,
`400 CONTENT_PERIOD_TOO_LARGE`, sem cortar); não pagina. A resposta é
`{ data: { contents, storyScripts }, meta: { from, to, count } }`, ordenada por dia, hora (sem hora por
último) e `id`. O item de conteúdo não traz legenda nem mídia.
`thumbnailAssetId` é o id do arquivo que serve de capa no card e no feed: a capa escolhida (`coverAssetId`),
senão a primeira mídia confirmada e não removida, por posição, ou `null` (issue #606; a imagem é lida como
`variant=thumbnail`, e o vídeo, pelo quadro gerado). Nenhum outro dado da mídia entra na lista.

## O feed do cliente

O celular ao lado do calendário lê o feed do cliente inteiro, sem período (decisão
`2026-11-04-o-celular-do-calendario-mostra-o-feed-inteiro-do-cliente`). É a leitura própria porque a consulta por
período tem teto de 93 dias e 500 itens. `GET .../contents/feed?cursor=`: só `image`, `carousel` e `reels`, sem
cancelados, da data mais recente para a mais antiga (dia, hora e id, todos decrescentes; sem hora conta como o fim do dia),
9 itens por página. A resposta é `{ data: { contents, nextCursor, counters: { posts, approved, awaitingApproval } | null },
meta: { count } }`: o item tem o formato do item da consulta por período, `nextCursor` é `null` na última página e
os contadores são do feed inteiro, não da página, e vêm só na primeira página (sem `cursor`); nas seguintes `counters` é `null` e quem lê guarda o que a primeira disse. A rota tem limite de 300 leituras por minuto por pessoa: a 301ª responde `429 RATE_LIMITED` com `Retry-After`. O cursor é opaco (base64url de dia, hora e id do último post da
página) e vai de volta sem mudar; um que a rota não devolveu é `400 VALIDATION_ERROR`. O cliente é sempre o do caminho,
na agência do caminho (outro cliente ou outra agência é o mesmo `404`), e o cliente arquivado também responde. Os
contadores vêm de `app_private.content_feed_counters` (migration `20261104000300`), que confere `conteudo.visualizar` na agência do cliente uma vez e conta; a mesma
contagem sob a política de `contents` chama a permissão para cada linha (de 2,5 a 3,8 s em 40 mil conteúdos) e prendia o pool da API. Quem a política não deixa ver
não recebe linha da função e lê zeros, como antes. O índice `(client_id, publish_on)` basta para a ordem.

## O que o banco decide e a rota só traduz

O estado, a aprovação e a revisão são do banco (gatilhos da migration `20261007001200`): a rota grava as
colunas que o grant permite e devolve a linha lida depois. Por isso um `PATCH` de legenda, capa, formato
ou mídia num conteúdo aprovado devolve `awaiting_approval`, e mudar data, hora, título ou responsável
mantém a aprovação.

- **Escrita exige leitura.** A guarda da rota pede as duas permissões, como a policy.
- **O responsável** só muda com `conteudo.aprovar_pela_agencia` (`403` antes de gravar; o gatilho do banco
  também recusa, com `42501`, e a rota traduz).
- **O responsável é dito pelo vínculo** (#552, decisão `2026-10-11-responsavel-do-conteudo-pelo-vinculo-na-api.md`):
  a resposta traz `owner: { membershipId, name }` (`null` para quem não tem vínculo com a agência) e o corpo
  de `POST` e `PATCH` leva `ownerMembershipId`, nunca um id de usuário. Um vínculo que não é ativo, de colaborador, desta
  agência e de quem vê Conteúdo é `400 CONTENT_OWNER_INVALID`; sem a permissão, `403` qualquer que seja o vínculo.
  Nenhuma resposta traz o id de usuário de ninguém: `approvedBy` é `{ name, side }` (`agency` ou `client`, pelo vínculo
  do lado) e o responsável de uma subtarefa é `assignee: { membershipId, name }`.
- **Formato e mídia** (`mediaAssetIds`, a lista inteira e ordenada) são gravados na mesma transação, o
  formato primeiro. Depois do envio para aprovação não se vai de carrossel para uma mídia só (nem o inverso)
  num `PATCH`: `409 CONTENT_MEDIA_INCOMPLETE`, e o caminho é cancelar e reagendar.
- **A corrida com o arquivamento** tem duas janelas, e as duas respondem `409 CLIENT_ARCHIVED` sem gravar:
  o arquivamento em curso (`A0020`) e o já confirmado antes da escrita (`42501` da policy, lido de novo
  numa transação nova). Ver `errors.ts`.

## As seis transições (issue #256)

Cada rota chama **uma função do banco** (`submit_content`, `approve_content_by_agency`, `publish_content`,
`unpublish_content`, `cancel_content`, `reschedule_content`) e devolve o conteúdo lido de volta (`ContentDetail`).
A função confere a permissão antes da trava, toma o cliente `FOR SHARE` antes da linha do conteúdo e lê o
cliente depois da espera, então a rota **não decide** estado, arquivamento nem permissão: traduz. Quem
aprovou, quando publicou e quando cancelou são do gatilho, nunca do corpo (`.strict()`).

- **Corpo.** `unpublish` e `cancel` não levam campo: aceitam `{}` ou nada, e um campo qualquer é
  `400 VALIDATION_ERROR` sem chamar o banco (#563); `submit` leva `{ dueAt?, dueOn?, note? }` (ver "A rodada de aprovação"; `{}` e nada
  continuam valendo, e outro campo é `400`); `approve-by-agency` leva `{ revision, reason }`
  (`revision` é a que a pessoa leu: `409 CONTENT_REVISION_CHANGED` se a legenda, a capa, o formato ou a
  mídia mudou; o motivo segue a regra única de texto livre e tem até 5000 bytes); `publish` leva
  `{ publishedOn? }` (hoje em `America/Sao_Paulo` se faltar, nunca no futuro: `400`); `reschedule` leva
  `{ publishOn? }`. Sem corpo vale como `{}`.
- **Piso de data.** `publishedOn` (publicar) e `publishOn` (criar, editar e reagendar) não aceitam dia antes de
  `2000-01-01` (`CONTENT_DAY_FLOOR`, `ContentDaySchema`): `400 VALIDATION_ERROR`, e o piso é aceito. O piso é da API; o banco
  não o confere (decisão `2026-10-11-conteudo-piso-de-data-corpo-estrito-e-dia-do-banco`).
- **O dia de hoje**, quando a publicação não traz `publishedOn`, é o do banco: `app_private.sao_paulo_date(pg_catalog.now())`,
  o mesmo relógio com que o gatilho recusa um dia no futuro. `dependencies.now` só existe para o teste fixar um instante e
  nunca é passado em produção. Desfazer a publicação é no dia (de São Paulo) em que ela foi **marcada**, regra
  do gatilho (`A0064` -> `409 CONTENT_UNPUBLISH_EXPIRED`).
- **Repetir** a ação num conteúdo que já está no estado de chegada é `200` sem mudança (a função devolve).
- **Mídia.** `A0065` é lido de novo numa transação nova: com mídia que não terminou de subir é
  `409 CONTENT_MEDIA_NOT_CONFIRMED`; sem mídia completa, ou com a capa removida da pasta, é
  `409 CONTENT_MEDIA_INCOMPLETE` (a mensagem cita a capa). `approve-by-agency` ainda confere, depois da função e
  dentro da mesma transação, que nenhuma mídia está pendente: se estiver, desfaz tudo.
- **A fila de e-mail** (#407) é escrita pelo gatilho do banco quando o conteúdo passa a "aguardando aprovação"
  ou a "publicado"; a rota não escreve nela e o teste confere uma linha por pessoa ativa do portal, sem duplicar.
- **Cliente arquivado:** `409 CLIENT_ARCHIVED` em toda ação, nas duas janelas da corrida
  (`contents-transitions-race.integration.test.ts`).

### A cobertura em dobro das corridas com o arquivamento

Três travas do banco protegem as seis ações, e algumas ações têm mais de uma. Quem mexer numa delas precisa saber que as outras
sustentam os mesmos testes:

1. **A trava da função** (`app_private.lock_content_for_agency`, usada pelas seis funções): toma o cliente `FOR SHARE` antes da linha
   do conteúdo e o lê depois da espera. Basta sozinha para as seis ações. Quem a prova é
   `contents-transitions-race.integration.test.ts` (18 testes: seis ações, três janelas cada, a do arquivamento em curso, a do
   arquivamento já confirmado e a da linha presa por outra transação). Sem o `FOR SHARE`, 14 dos 18 ficam vermelhos.
2. **O gatilho `AFTER INSERT` da fila de e-mail** (`0_notification_queue_lock_active_client`, #407): `submit` e `publish` enfileiram
   um aviso por pessoa do portal, e o `INSERT` toma o cliente ativo e responde `A0020`. Quem o prova é
   `packages/database/test/conteudo-notification-queue.integration.test.ts` (o gatilho é o primeiro `AFTER INSERT` da fila e recusa
   a linha de um cliente arquivado).
3. **O gatilho de edição `0_contents_edit_lock_active_client`** (migration `20261011000600`, #538): `reagendar` muda `publish_on`, e o
   `UPDATE` de uma coluna editável do conteúdo toma o cliente ativo. Quem o prova é `contents-archive-race.integration.test.ts` (a
   edição enquanto o arquivamento está em curso e a que confirma antes do `UPDATE`) e a lista de gatilhos de
   `packages/database/test/client-archive.integration.test.ts`.

Os 4 dos 18 testes que continuam verdes sem a trava da função são a janela "em curso" de `submit`, `publish` e `reschedule` e a
"confirmada antes" de `reschedule`: cada um é coberto também pela trava 2 (`submit`, `publish`) ou pela 3 (`reschedule`). Sem as três
juntas, os 18 ficam vermelhos. Os 4 casos são proteção em dobro, não teste vazio.

## A rodada de aprovação e o envio em lote (escopo `telas-melhorias`, S4; o prazo com hora, escopo `redesign-igual`, A2)

Decisões `2026-11-10-estrutural-a-rodada-de-aprovacao-tem-prazo-e-recado`, `2026-11-10-estrutural-lembretes-de-aprovacao-vence-amanha-e-venceu`,
`2026-11-11-estrutural-o-prazo-de-aprovacao-tem-hora-e-padrao-de-48-horas` e
`2026-11-11-estrutural-a-rodada-de-aprovacao-mostra-ao-cliente-quem-enviou-e-aceita-recado-ao-aprovar`.
O banco decide (migrations `20261110000100` e `20261111000200`: `submit_content(uuid, timestamptz, text)`,
`submit_contents(uuid[], timestamptz, text)`, a tabela `content_approval_rounds`); a rota entrega o corpo e traduz.

- **Envio individual.** `POST .../contents/:contentId/submit` leva `{ dueAt?, dueOn?, note? }` (`SubmitContentRequestSchema`, que é só dele:
  `ContentMoveRequestSchema` segue sem campo para `cancel` e `unpublish`). `dueAt` é o prazo como instante, com fuso
  (`2026-11-12T18:00:00-03:00`); `dueOn` continua valendo, e é o fim desse dia em São Paulo (23:59); os dois juntos são `400`. O banco
  guarda `due_at` e deriva `due_on`, o dia de São Paulo dele, que os lembretes e os e-mails seguem lendo. O contrato confere o formato do
  instante e o devolve **em UTC** (`ApprovalDueAtSchema`: o mesmo instante escrito com `+16:00` ou `-23:59`, que o banco não lê, chega à função
  em UTC; um deslocamento que nenhum relógio tem, como `+99:99`, e um instante fora dos anos 0001 a 9999 são `400 VALIDATION_ERROR`, nunca `500`)
  e o texto do recado (1 a 500 caracteres, sem invisível, aparado); que o prazo esteja entre agora (exclusive) e 90 dias à frente é do
  banco (`A0120` -> `400 CONTENT_APPROVAL_DUE_INVALID`). O padrão de 48 horas é da tela: a API aceita o envio sem prazo.
  `A0068` num `submit` é a nota (`400 CONTENT_APPROVAL_NOTE_INVALID`), e em `approve-by-agency` é o motivo:
  `translateTransitionError` diz qual pelo movimento. `A0062` também cobre "já aguarda com outro prazo ou recado" (`409 CONTENT_STATE`).
- **Lote.** `POST .../clients/:clientId/contents/submit` leva `{ contentIds, dueAt?, dueOn?, note? }` (1 a 30 ids distintos). A rota lê cada
  conteúdo como **deste cliente** antes da função (`countClientContents`): um de outro cliente da mesma agência, de outra agência ou
  inexistente é `404 NOT_FOUND`, igual ao envio individual e sem dizer qual; sem isso um lote de um cliente só, mas o de outro, passaria,
  porque a função só recusa um lote que mistura clientes (`A0122` -> `400 CONTENT_BATCH_MIXED_CLIENTS`, que a rota só vê numa corrida). Mais de 30 ou
  repetido é `A0121` (`400 CONTENT_BATCH_INVALID`), mas o contrato o recusa antes (`400 VALIDATION_ERROR`). Tudo ou nada: um conteúdo recusado
  desfaz o lote com o código do envio individual. A resposta é `{ data: { batchId, contents } }`, com os conteúdos lidos como o calendário os lê.
- **`approval`** no item e no detalhe do conteúdo da agência: `{ sentAt, dueAt, dueOn, note }` da rodada mais recente **enquanto o conteúdo aguarda
  aprovação**, senão `null` (também para o que aguardava antes das rodadas). É a junção `APPROVAL_JOIN` de `service.ts`, que a lista, o
  feed, o detalhe e o lote compartilham.
- **O portal** devolve `approval: { dueAt, dueOn, note, sentAt, sentBy }` (`portalApprovalOf`, uma só cópia, que `portal-routes.ts` exporta e
  `approval-links/service.ts` importa por essa porta), vindo de `portal_contents`. `sentBy` é `{ name, photoUrl }` de quem da agência enviou
  (ver `portal.md`); o lote não sai do banco. `photoUrl` é o **caminho** `/clients/:clientId/contents/:contentId/sender-photo`, uma rota do
  portal sob a mesma guarda do cliente que responde os bytes da imagem (`404` único sem foto, sem acesso ou com o armazenamento fora do ar;
  `Cache-Control: private`, `nosniff`, limite por pessoa): nenhum endereço assinado, que levaria a chave do objeto e com ela o id da conta de
  quem enviou. Só uma chave de avatar (`users/<id>/avatar/...`) é lida do armazenamento, pelo `IdentityStorageClient.readImage`.
- **Recado em conteúdo já aprovado.** `approve` com `note` num conteúdo que já está aprovado é `A0123` -> `409 CONTENT_ALREADY_APPROVED`
  ("Este conteúdo já foi aprovado. Seu recado não foi enviado."), decidido depois da trava do conteúdo na função do banco (uma só cópia da regra,
  porque é lá que duas pessoas aprovando juntas se separam); sem recado, o conteúdo já aprovado segue um `200` que não escreve nada. **O link de aprovação** do e-mail continua com o dia e o recado: o `dueAt`, o `sentAt` e o
  `sentBy` dele são `null` (vem de `portal_approval_contents`, que esta entrega não mexe).
- **Parado no cliente.** `GET /agencies/:agencyId/contents/awaiting-client` (`awaiting-routes.ts`, `awaiting-service.ts`): o que aguarda
  aprovação, até 50 (`meta.truncated` quando havia mais), de quem espera há mais tempo ao mais novo (`sentAt`; o sem rodada vem por último,
  pelo dia da publicação; o prazo não ordena, é um dado a mais em cada linha), agrupado por cliente na ordem do primeiro item de cada um; o teto
  corta o mais novo. Cada item leva `thumbnailAssetId` (a capa, `THUMBNAIL_JOIN` de `service.ts`, a mesma da lista), `dueAt`, `dueOn` e
  `daysLate` (dias desde o dia da publicação, só depois que ele passou). Os dias (`daysToDue`, `daysWaiting`, `daysLate`) são do dia de São
  Paulo (`app_private.sao_paulo_date`) de um só instante, o `now` da dependência ou o relógio do banco. `approvers` de cada cliente são os nomes
  (só nome: sem e-mail, id ou papel) das pessoas ativas do portal que já entraram, na ordem em que receberam o acesso, até 50
  (`portal-people.ts`); só quem tem `cliente.convidar_usuario` na agência os recebe, e para os outros `approvers` é `null` (a tabela de acessos
  também é lida por quem remove pessoas, então a permissão é perguntada à parte, não deixada à política). Quem vê a lista é o que a política de
  `contents` dá a quem tem `conteudo.visualizar`, a mesma do calendário e do feed (guarda da rota + política da tabela, sem cópia da regra);
  cliente arquivado não entra. Não há restrição de carteira por colaborador no modelo (`ClientAssignment` não existe): a visibilidade é a
  permissão na agência.
- **Contadores.** `GET /agencies/:agencyId/contents/summary` (`summary-routes.ts`, `summary-service.ts`): "Esperando" (`awaitingClient`),
  "Atrasados" (`overdueAwaitingClient`: aguardando cujo dia de publicação, em São Paulo, passou), "Aprovados no mês" e o do mês anterior
  (`approvedThisMonth`, `approvedLastMonth`: aprovados e publicados pelo dia de São Paulo da aprovação, a de fora da plataforma inclusive; é a
  contagem de hoje de cada mês, não um histórico) e "Agendados" (`scheduled.count` e `lastPublishOn`: aprovados com hora cujo instante ainda
  não passou, `contentIsScheduled` do contrato, que `deadline-sql.ts` repete em SQL e um teste confere). Um instante só (`clock-sql.ts`) dá o dia,
  os meses e a hora do dia, então os números de uma resposta concordam. Mesma permissão e mesma política das outras leituras do Início; só
  clientes ativos.
- **Passos da ativação.** `GET .../contents/activation` devolve, além dos quatro fatos, `steps` (`activation-service.ts`): data e nome do primeiro
  cliente, do primeiro conteúdo, do primeiro envio (a primeira pessoa ativa do portal que entrou, com "e mais N" em `others`; sem
  `cliente.convidar_usuario` ou sem pessoa, o nome do cliente e `others: 0`) e da primeira aprovação (quem aprovou, como o detalhe o nomeia;
  o nome do cliente se a conta não for conhecida). Um passo é `null` quando não foi dado ou quando nada o data (o que aguardava antes das rodadas
  não tem data de envio).
- **Roteiros do período.** Cada roteiro leva `sceneCount`, o número de cenas.

## As subtarefas (issue #255)

Cinco rotas, em `task-routes.ts`, e todas devolvem a **subtarefa** (`ContentTask`, a mesma forma dos itens de `tasks`
do detalhe); criar responde `201`. O estado, quem pode e o cliente arquivado são do banco (`deliver_content_task`,
`approve_content_task`, `return_content_task`, o gatilho de `content_tasks`): a rota confere só que a subtarefa é do
conteúdo do caminho e o conteúdo, do cliente (o mesmo `404 Task not found.`), e traduz o que o banco recusa.

- **Quem faz o quê é um valor da linha**, então entregar, aprovar e devolver pedem só `conteudo.visualizar` na rota.
  Só o responsável **da subtarefa** entrega (`403` para qualquer outra pessoa, o Admin e o Owner inclusive); só o
  responsável **do conteúdo** ou quem tem `conteudo.aprovar_pela_agencia` aprova ou devolve (o responsável é lido da
  linha no momento da chamada, então a troca de responsável vale na hora). Criar e editar pedem `conteudo.operar`.
- **A pessoa responsável** é dita por vínculo: a resposta traz `assignee: { membershipId, name }` e o corpo leva
  `assigneeMembershipId`, nunca um id de usuário (`approvedBy` é `{ name, side }`). Um vínculo que não é ativo, de
  colaborador, desta agência e de quem vê Conteúdo é `400 CONTENT_TASK_ASSIGNEE_INVALID`, com a mesma mensagem
  para qualquer motivo; sem a permissão de escrever, `403` antes de olhar o vínculo; cliente arquivado, `409` antes.
- **Devolver** exige `comment`, pela regra única de texto livre (`400 VALIDATION_ERROR` para texto vazio, só de caractere
  invisível ou de controle, ou com mais de 5000 bytes). O comentário fica em `returnComment` até a próxima entrega
  e **não** vai para a conversa do conteúdo, que é do cliente.
- **Estado.** `409 CONTENT_TASK_STATE` para a ação que o estado da subtarefa não aceita, para editar uma subtarefa
  aprovada e para qualquer escrita nas subtarefas de um conteúdo publicado ou cancelado. Entregar uma entregue e
  aprovar uma aprovada são `200` sem mudança.
- **Teto.** Um conteúdo tem até 50 subtarefas, em qualquer estado: a 51ª criação é `409 CONTENT_TASK_LIMIT` (decisão do
  maestro). Vale só para criar. A contagem é feita depois de uma trava consultiva por conteúdo, para duas criações ao
  mesmo tempo não chegarem a 51.
- **O percentual** do conteúdo (`tasksApproved` sobre `tasksTotal`, na consulta por período e no detalhe) conta as
  linhas de `content_tasks` na hora da leitura, então reflete cada aprovação sem outra escrita.
- **Cliente arquivado:** `409 CLIENT_ARCHIVED` nas duas janelas da corrida, em criar (gatilho do `INSERT`), editar
  (gatilho do `UPDATE`, #545) e nas três ações (a função toma o cliente `FOR SHARE` antes da linha e o lê depois da espera).

## O que ficou de fora

Mídia e pastas (`apps/api/src/modules/media`, #253), os estados do portal (#257, #259),
roteiros (#258) e o portal. O texto livre usa os schemas de `packages/contracts` (título de uma linha,
legenda com quebras), que recusam caractere de controle e invisível.

## Testes

- `contents.integration.test.ts`: autorização por rota com papéis de uma ou duas permissões, isolamento
  (inclusive a pessoa com vínculo em duas agências), o período, criar, ler, editar e mover.
- `contents-archive-race.integration.test.ts`: as duas janelas da corrida com o arquivamento e o deadlock.
- `errors.test.ts`: a tradução de cada código do banco, sem banco.
- `contents-transitions.integration.test.ts` (#256): a matriz de papéis de uma permissão por ação, o
  isolamento, cada transição, a mídia, o motivo, o dia de São Paulo, a fila e o cliente arquivado.
- `contents-transitions-race.integration.test.ts` (#256): por ação, o arquivamento em curso, o
  arquivamento que confirma antes da função e a linha presa por outra transação.
- `transition-errors.test.ts`: a tradução de cada código das transições, sem banco.
- `contents-transition-input.integration.test.ts` (#563): o piso de data (`1999-12-31` e `0001-01-01` recusados, `2000-01-01`
  aceito) em publicar, reagendar, criar e editar; o corpo estrito de `submit`, `unpublish` e `cancel`; e o dia da publicação pelo
  relógio do banco, com o da API anos atrás.
- `contents-approval-rounds.integration.test.ts` (S4): o envio individual e em lote com prazo e recado (as duas pontas dos 90 dias, o recado
  de 500 e 501 caracteres, o lote de 30 e 31, o conteúdo de outro cliente, o tudo ou nada, a matriz de papéis, o cliente arquivado), o
  `approval` onde o conteúdo é lido e cada código do banco traduzido, nunca um 500.
- `contents-awaiting-client.integration.test.ts` (S4, A2): "Parado no cliente" a 01:30Z (ainda a noite anterior em São Paulo), a ordem por
  envio, a capa, o prazo com hora, `daysLate`, os aprovadores (e quem os recebe), o agrupamento, o teto de 50, o que fica de fora, e quem vê (a
  permissão, o isolamento entre agências e a pessoa de duas agências).
- `contents-summary.integration.test.ts` (A2): os contadores, as bordas do mês, do dia e da hora de São Paulo com o relógio injetado, o
  "Agendado" igual ao do contrato, e quem vê.
- `contents-activation.integration.test.ts`: os fatos e, em A2, os passos com data e nome.
- `portal-home.integration.test.ts` (A2): o progresso do mês do portal, "O que precisa de você" na ordem do prazo com hora, o remetente da
  rodada (nome e foto, nunca e-mail ou id) e aprovar com recado.
- `contents-owner-link.integration.test.ts` (#552, #566): o responsável por vínculo, na resposta e no corpo: nenhum id de usuário
  (de qualquer pessoa do cenário, a do portal e as das fixtures inclusive), vínculo removido, de outra agência, do portal,
  inexistente ou de quem não vê Conteúdo (recusado pela rota antes de escrever, e a matriz que a compara com `agency_user_can`),
  a pessoa de duas agências e o `403` antes do `400`.
- `contents-tasks.integration.test.ts` (#255): quem entrega, aprova e devolve com papéis de uma permissão só (o responsável da
  subtarefa, o do conteúdo e quem aprova pela agência, e a troca do responsável do conteúdo), criar e editar, o responsável por
  vínculo (removido, de outra agência, do portal, inexistente e de quem não vê Conteúdo, todos a mesma resposta), o texto livre, o
  estado, o percentual na consulta por período, o isolamento e o cliente arquivado.
- `contents-tasks-race.integration.test.ts` (#255): por escrita, o arquivamento em curso, o que confirma antes da instrução e a
  linha presa por outra transação.
- `task-errors.test.ts`: a tradução de cada código do banco nas rotas de subtarefa, sem banco.
