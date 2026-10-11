# Módulo `contents` (issue #254)

O conteúdo de um cliente, do lado da agência: a **consulta por período** (calendário e feed), criar,
ler e editar, e mover de data (que é editar `publishOn`). Todas as rotas sob `requireSession` e
`requireAgencyAccess`; o cliente de `:clientId` precisa pertencer à agência do caminho, e o conteúdo,
ao cliente, senão o mesmo `404`.

| método | rota | permissão |
|---|---|---|
| `GET` | `/agencies/:agencyId/clients/:clientId/contents?from=&to=` | `conteudo.visualizar` |
| `POST` | `/agencies/:agencyId/clients/:clientId/contents` | `conteudo.operar` e `conteudo.visualizar` |
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

## A consulta por período

É o formato que Tarefas e Dashboard copiam. `from` e `to` são dias `AAAA-MM-DD` incluídos; até 93 dias
contando os dois extremos (93 passa, 94 é `400`); até 500 itens somando conteúdos e roteiros (acima,
`400 CONTENT_PERIOD_TOO_LARGE`, sem cortar); não pagina. A resposta é
`{ data: { contents, storyScripts }, meta: { from, to, count } }`, ordenada por dia, hora (sem hora por
último) e `id`. O item de conteúdo não traz legenda nem mídia.

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

- **Corpo.** `submit`, `unpublish` e `cancel` não têm; `approve-by-agency` leva `{ revision, reason }`
  (`revision` é a que a pessoa leu: `409 CONTENT_REVISION_CHANGED` se a legenda, a capa, o formato ou a
  mídia mudou; o motivo segue a regra única de texto livre e tem até 5000 bytes); `publish` leva
  `{ publishedOn? }` (hoje em `America/Sao_Paulo` se faltar, nunca no futuro: `400`); `reschedule` leva
  `{ publishOn? }`. Sem corpo vale como `{}`.
- **O dia de hoje** vem de `now()` do módulo (`dependencies.now`, fixado nos testes) passado por
  `app_private.sao_paulo_date`. Desfazer a publicação é no dia (de São Paulo) em que ela foi **marcada**, regra
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
- `contents-owner-link.integration.test.ts` (#552): o responsável por vínculo, na resposta e no corpo: nenhum id de usuário,
  vínculo removido, de outra agência, do portal ou inexistente, a pessoa de duas agências e o `403` antes do `400`.
- `contents-tasks.integration.test.ts` (#255): quem entrega, aprova e devolve com papéis de uma permissão só (o responsável da
  subtarefa, o do conteúdo e quem aprova pela agência, e a troca do responsável do conteúdo), criar e editar, o responsável por
  vínculo (removido, de outra agência, do portal, inexistente e de quem não vê Conteúdo, todos a mesma resposta), o texto livre, o
  estado, o percentual na consulta por período, o isolamento e o cliente arquivado.
- `contents-tasks-race.integration.test.ts` (#255): por escrita, o arquivamento em curso, o que confirma antes da instrução e a
  linha presa por outra transação.
- `task-errors.test.ts`: a tradução de cada código do banco nas rotas de subtarefa, sem banco.
