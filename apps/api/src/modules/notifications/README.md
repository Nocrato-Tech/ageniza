# Notificações dentro do app

A API das notificações da pessoa da agência (`specs/notificacoes.md` seções 2, 5, 6 e 8; decisão
`2026-11-11-estrutural-notificacoes-so-dentro-do-app-com-cinco-eventos`), sobre a tabela, as funções e a RLS de
`20261112000200_notifications.mjs` e o contrato de `packages/contracts/src/notifications.ts`. Uma notificação é **da pessoa que
a recebe**: a rota lê como a pessoa, e quem decide o que é dela é o banco.

## As rotas

Todas sob `requireSession` e `requireAgencyAccess`, sem permissão própria: basta o vínculo ativo com a agência.

| rota | o que faz |
|---|---|
| `GET /agencies/:agencyId/notifications` | a lista paginada (20 por página), da mais recente à mais antiga, com `id` desempatando; `unread=true` só as não lidas |
| `GET /agencies/:agencyId/notifications/unread-count` | `{ data: { count } }`, o ponto do sino |
| `POST /agencies/:agencyId/notifications/:notificationId/read` | `204`; a de outra pessoa, a de outra agência, a que perdeu a permissão do assunto e a inexistente são o mesmo `404` |
| `POST /agencies/:agencyId/notifications/read-all` | `204`; marca as não lidas da pessoa nessa agência |

## Onde cada regra mora

- **Quem lê o quê é da policy.** A lista e a contagem são `SELECT` em `public.notifications` sob a policy, que confere a cada leitura o
  destinatário, o vínculo ativo e a permissão do assunto. A rota filtra a agência da URL (a policy deixaria a pessoa de duas agências
  ver as linhas de ambas) **e** a pessoa (`recipient_user_id = app_private.current_user_id()`), nas três consultas: sem ela o plano
  varre as notificações da agência inteira, deixa os índices por destinatário sem uso, e a rota passa a depender só da policy. Os dois
  filtros ficam, cada um com o seu teste. Quem só tem vínculo com um cliente, ou é de outra agência, não passa do guard
  (`404 Agency not found.`); Owner e Admin leem as próprias, nunca as dos outros.
- **Marcar é do banco.** `app_private.read_notification` devolve `false` para o que não é da pessoa (`404`) e `read_all_notifications`
  devolve quantas marcou. A rota decide pelo que a função devolveu, nunca por uma leitura antes dela. O instante da leitura é do banco
  e a primeira leitura é a que vale.
- **Nenhuma rota cria notificação.** Os cinco eventos criam a sua dentro das funções do banco que os executam, e o prazo vencido é o
  trabalho do worker. Esta API não chama nada a mais em aprovar, pedir ajuste, responder pedido ou aceitar convite.
- **Erros do banco** (`errors.ts`): `40P01` e `40001` viram `409 TRY_AGAIN`, `42501` vira `403`, `22P02` e os demais `A00xx` viram o
  `404` da notificação, e os `A009x` do plano seguem o tratamento global. Nada que o banco levanta aqui é `500`, e nada do detalhe
  dele chega à resposta.
- **O destino** (`service.ts`) sai do tipo e dos ids da linha: o conteúdo (`clientId` e `contentId`), o pedido de material (`clientId` e
  `threadId`) ou a equipe, para o convite aceito.

## O que ficou de fora

Apagar, arquivar e silenciar notificação, e qualquer envio por e-mail ou push (`specs/notificacoes.md` seção 1).
