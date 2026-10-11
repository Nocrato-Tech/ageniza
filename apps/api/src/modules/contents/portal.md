# O portal do módulo `contents` (issue #257)

Os conteúdos de um cliente vistos pela pessoa do portal dele, e as duas ações dela: aprovar e pedir ajuste. Todas as rotas sob
`requireSession` e `requireClientAccess` (o vínculo ativo com o cliente é a única autorização); o cliente é sempre o que o guarda
provou. As decisões estão em `docs/business/decisions/2026-10-11-conteudo-portal-na-api-recorte-aprovar-e-pedir-ajuste.md`.

| método | rota | o que faz |
|---|---|---|
| `GET` | `/clients/:clientId/contents?from=&to=` | os conteúdos de um período, `{ data, meta: { from, to, count } }` |
| `GET` | `/clients/:clientId/contents/awaiting-approval` | o que espera a aprovação, paginado |
| `GET` | `/clients/:clientId/contents/:contentId` | o post: legenda, `revision` e mídia a partir de "aguardando aprovação" |
| `POST` | `/clients/:clientId/contents/:contentId/approve` | `{ revision }`: aguardando aprovação → aprovado |
| `POST` | `/clients/:clientId/contents/:contentId/request-changes` | `{ revision, comment }`: aguardando aprovação → em ajuste, e o comentário entra na conversa |

## Onde cada regra mora

- **O recorte é a forma da resposta.** Um conteúdo em produção é o schema estrito `{ id, title, format, publishOn, status }`
  (`packages/contracts/src/portal-contents.ts`): sem legenda, sem hora, sem capa. Nenhum schema do portal tem subtarefa, responsável,
  prazo interno, quem aprovou, pasta ou id de usuário, e o teste procura essas chaves, e os valores semeados, no corpo inteiro de toda rota.
- **O portal nunca seleciona da tabela.** `portal-service.ts` lê por `app_private.portal_contents` e `app_private.portal_content_media`,
  que respondem pelo vínculo ativo e por mais nada. Uma pessoa que também é colaboradora (a que lê rascunho, legenda e cancelado pelo
  ramo da agência da policy) recebe o mesmo recorte; o teste exercita `dualAdmin`, `dualRead`, `dualBare` e `crossDual` em toda rota, e
  confere que nenhuma instrução do portal menciona `public.contents`. Cancelado não existe para o portal: `404`.
- **O estado é do banco.** `approve_content` e `request_content_changes` decidem o estado, quem agiu (a sessão) e quando. A rota lê o
  conteúdo pelo recorte do portal antes (outro cliente, cancelado e inexistente são o mesmo `404 Content not found.`, também para quem lê
  os dois clientes), recusa o que está em produção com `409 CONTENT_NOT_AWAITING_APPROVAL` e chama a função, que o recusa de novo por dentro.
- **Aprovar é idempotente, pedir ajuste não.** Aprovar o que já está aprovado é `200` e a primeira pessoa continua sendo quem aprovou;
  pedir ajuste de um conteúdo já em ajuste é `409`, porque cada pedido é um comentário.
- **A agência lê quem aprovou, o portal não.** A agência vê `approvedBy: { name, side: 'client' }` (sem id); a resposta do portal não
  tem esse campo.
- **O pedido de ajuste é uma função só.** Abre (ou acha) a conversa do conteúdo, grava o comentário como o cliente e leva o conteúdo a
  "em ajuste", na mesma transação: um comentário recusado não deixa conversa nem estado. O comentário segue a regra única de texto livre
  das conversas (`CommentBodySchema`): só espaço, só caractere invisível e só caractere de controle são vazios.

## A corrida

As duas funções travam o cliente ativo (`FOR SHARE`) antes do conteúdo (`FOR UPDATE`). Aprovar e pedir ajuste do mesmo conteúdo ao
mesmo tempo: um ganha e o outro é `409`. A agência que cancela enquanto o pedido espera: `404` (a rota relê o recorte do portal
quando o banco responde `A0062`). A agência que edita a legenda enquanto a aprovação espera: `409 CONTENT_REVISION_CHANGED`. O arquivamento
do cliente, nas duas janelas (em curso e já confirmado), é `404`, sem gravar nada; o portal nunca fica sabendo que o cliente foi arquivado.

## Erros do banco

`translatePortalError` (`portal-errors.ts`): `A0060`, `A0061` e `A0020` são `404`; `A0062`, `409 CONTENT_NOT_AWAITING_APPROVAL`; `A0063`,
`409 CONTENT_REVISION_CHANGED`; `A0068`, `400 CONTENT_COMMENT_INVALID`; `40P01` e `40001`, `409 TRY_AGAIN`; `42501` é relido numa transação
nova (o vínculo ainda vale: `403`, senão `404`). Nenhum erro do banco chega como `500`, e nenhuma resposta leva a mensagem dele.
