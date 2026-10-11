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

Os contratos estão em `packages/contracts/src/contents.ts`; as decisões, em
`docs/business/decisions/2026-10-11-conteudo-*.md`, `2026-10-11-consulta-por-periodo-teto-de-500-itens-e-formato-da-resposta.md`
e `2026-10-11-transicoes-do-conteudo-na-api-corpo-dia-real-e-codigos.md`. As subtarefas, as pastas e os roteiros
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

## O que ficou de fora

Mídia e pastas (`apps/api/src/modules/media`, #253), subtarefas (#255), os estados do portal (#257, #259),
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
