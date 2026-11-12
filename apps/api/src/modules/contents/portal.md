# O portal do módulo `contents` (issue #257)

Os conteúdos de um cliente vistos pela pessoa do portal dele, e as duas ações dela: aprovar e pedir ajuste. Todas as rotas sob
`requireSession` e `requireClientAccess` (o vínculo ativo com o cliente é a única autorização); o cliente é sempre o que o guarda
provou. As decisões estão em `docs/business/decisions/2026-10-11-conteudo-portal-na-api-recorte-aprovar-e-pedir-ajuste.md`.

| método | rota | o que faz |
|---|---|---|
| `GET` | `/clients/:clientId/contents?from=&to=` | os conteúdos de um período, `{ data, meta: { from, to, count } }` |
| `GET` | `/clients/:clientId/contents/awaiting-approval` | o que espera a aprovação, paginado, na ordem do prazo (com a hora) |
| `GET` | `/clients/:clientId/contents/progress` | o progresso do mês ("Boa notícia") e o próximo post a ir ao ar |
| `GET` | `/clients/:clientId/contents/:contentId` | o post: legenda, `revision` e mídia a partir de "aguardando aprovação" |
| `GET` | `/clients/:clientId/contents/:contentId/media/:assetId/url?variant=` | a URL assinada da capa ou de um item da mídia (#584) |
| `POST` | `/clients/:clientId/contents/:contentId/approve` | `{ revision, note? }`: aguardando aprovação → aprovado; o `note` (recado à agência, até 500 caracteres) vira comentário do cliente na conversa, na mesma transação |
| `POST` | `/clients/:clientId/contents/:contentId/withdraw-approval` | `{ revision }`: aprovado → aguardando aprovação, com vínculo próprio ativo e evento `content.approval_withdrawn`; publicado é conflito |
| `POST` | `/clients/:clientId/contents/:contentId/request-changes` | `{ revision, comment }`: aguardando aprovação → em ajuste, e o comentário entra na conversa |

## Onde cada regra mora

- **O recorte é a forma da resposta.** Um conteúdo em produção é o schema estrito `{ id, title, format, publishOn, status }`
  (`packages/contracts/src/portal-contents.ts`): sem legenda, sem hora, sem capa. Nenhum schema do portal tem subtarefa, responsável,
  prazo interno, quem aprovou, pasta ou id de usuário, e o teste procura essas chaves, e os valores semeados, no corpo inteiro de toda rota.
- **A capa do card é `thumbnailAssetId`, e só nos itens abertos das listas** (o período e o que espera aprovação; o detalhe do post não a repete):
  a capa escolhida, senão a primeira mídia por posição, lidas da mesma `app_private.portal_content_media`, que já deixa de fora o arquivo removido
  ou não confirmado; `null` sem mídia. Um conteúdo em produção nunca a tem (issue #606).
- **O portal nunca seleciona da tabela.** `portal-service.ts` lê por `app_private.portal_contents` e `app_private.portal_content_media`,
  que respondem pelo vínculo ativo e por mais nada. Uma pessoa que também é colaboradora (a que lê rascunho, legenda e cancelado pelo
  ramo da agência da policy) recebe o mesmo recorte; o teste exercita `dualAdmin`, `dualRead`, `dualBare` e `crossDual` em toda rota, e
  confere que nenhuma instrução do portal menciona `public.contents`. Cancelado não existe para o portal: `404`.
- **O estado é do banco.** `approve_content` e `request_content_changes` decidem o estado, quem agiu (a sessão) e quando. A rota lê o
  conteúdo pelo recorte do portal antes (outro cliente, cancelado e inexistente são o mesmo `404 Content not found.`, também para quem lê
  os dois clientes), recusa o que está em produção com `409 CONTENT_NOT_AWAITING_APPROVAL` e chama a função, que o recusa de novo por dentro.
- **Aprovar é idempotente, pedir ajuste não.** Aprovar o que já está aprovado é `200` e a primeira pessoa continua sendo quem aprovou, sem
  um segundo recado; pedir ajuste de um conteúdo já em ajuste é `409`, porque cada pedido é um comentário.
- **Aprovar com recado é tudo ou nada.** `approve_content(uuid, integer, text)` aprova e, com recado, abre (ou acha) a conversa do conteúdo e
  grava o comentário do cliente na mesma transação: um comentário recusado (agência somente leitura) deixa o conteúdo aguardando, e uma
  aprovação recusada não deixa comentário. O recado segue a regra do da agência (`ApprovalNoteSchema`: sem caractere invisível ou de controle,
  aparado, nunca vazio, até 500 caracteres); em branco ou acima do limite é `400` (o contrato barra antes, `A0068` do banco é a segunda barreira,
  `400 CONTENT_APPROVAL_NOTE_INVALID`). Pedir ajuste continua exigindo o comentário (`CONTENT_COMMENT_INVALID`).
- **Cada item da mídia diz o que é.** `media[]` leva `kind` (`image` ou `video`), lido da categoria do arquivo pela mesma função do portal; a tela escolhe `<img>` ou `<video>` por ele. A capa não é item: o card pede `thumbnailAssetId` como `variant=thumbnail`, que é sempre imagem.
- **A agência lê quem aprovou, o portal não.** A agência vê `approvedBy: { name, side: 'client' }` (sem id); a resposta do portal não
  tem esse campo.
- **A rodada que o portal lê** (decisões de 2026-11-10 e 2026-11-11): `approval: { dueAt, dueOn, note, sentAt, sentBy }`. `dueAt` é o prazo como
  instante e `dueOn` o dia dele em São Paulo; `sentBy` é `{ name, photoUrl }` de quem da agência enviou a rodada, nada mais da pessoa: nem
  e-mail, nem id, nem papel, nem vínculo (o lote também não sai). Tudo vem de `app_private.portal_contents`, que lê a rodada mais recente e o
  remetente por dentro, então o portal segue sem `SELECT` em rodadas nem em contas. A foto é a chave que a conta guarda
  (`users/<id>/avatar/<versão>.<ext>`), assinada aqui (`signSenderPhotos`, uma assinatura local, sem conexão) só quando é de fato uma chave de
  avatar: qualquer outro texto, a falta de armazenamento ou uma assinatura que falha dão `photoUrl: null`, com o nome, e um log de código fixo
  (`PORTAL_SENDER_PHOTO_URL_FAILED`). O endereço assinado carrega a chave no caminho, como o das fotos de autor da conversa. A resposta de
  aprovar, pedir ajuste e desfazer leva o mesmo `approval`. O link de aprovação do e-mail não passa por aqui e responde `dueAt`, `sentAt` e
  `sentBy` nulos.
- **"O que precisa de você" segue o prazo.** A lista do que espera aprovação vem na ordem do instante do prazo da rodada mais recente (a hora
  desempata o dia), depois o dia e a hora da publicação; sem prazo, ou sem rodada, vem por último.
- **O progresso do mês** (`GET .../contents/progress`, `loadPortalProgress`): do mês de hoje em São Paulo, `total` são os conteúdos que não
  foram cancelados e `approved` os aprovados ou publicados; `next` é o aprovado mais cedo, a partir de hoje, cuja hora ainda não chegou (sem
  hora, vale o dia inteiro), ou `null`. Lê só por `app_private.portal_contents`, então vale o mesmo recorte do resto do portal. Um instante só
  (`clock-sql.ts`) dá o dia, o mês e a hora; o `now` da dependência o fixa nos testes.
- **O pedido de ajuste é uma função só.** Abre (ou acha) a conversa do conteúdo, grava o comentário como o cliente e leva o conteúdo a
  "em ajuste", na mesma transação: um comentário recusado não deixa conversa nem estado. O comentário segue a regra única de texto livre
  das conversas (`CommentBodySchema`): só espaço, só caractere invisível e só caractere de controle são vazios.

## A URL assinada da mídia (issue #584)

Decisões em `docs/business/decisions/2026-10-11-portal-assina-a-midia-do-conteudo-que-ve.md`. A rota só existe onde o storage de mídia
está configurado (como o módulo `media`), e não tem migration.

- **Assina só o que o portal lê.** A rota lê o conteúdo pelo recorte do portal (`loadPortalContent`: outro cliente, cancelado e
  inexistente são `404 Content not found.`; em produção também) e o arquivo por `app_private.portal_content_media` (a capa ou um item
  da mídia desse conteúdo, confirmado e não removido; qualquer outro é `404 Media asset not found.`). Nada é lido de `public.media_assets`
  nem de `public.contents`, então o colaborador que também tem vínculo recebe o mesmo recorte; o teste exercita `dualAdmin`, `dualRead`,
  `dualBare` e `crossDual` e confere as instruções enviadas.
- **A chave do original é montada, não lida:** a agência que o guarda provou para o cliente, o id e a extensão (a forma que a tabela impõe).
- **Variantes.** `original` (o padrão) assina e grava `media.download_url_issued` com a pessoa da sessão. `thumbnail` é o original para a imagem
  e a miniatura gerada para o vídeo (`409 VARIANT_NOT_READY` antes de processada, `409 VARIANT_PROCESSING_FAILED` após falha, sem o motivo do
  worker), e não grava auditoria. `preview` é `400`. A URL é só GET e dura `downloadUrlExpirySeconds`. O limite é por pessoa, 600 pedidos a cada 5 minutos, e é **o mesmo balde** da rota da agência (um só
  store, a mesma chave por usuário): quem lê pelos dois lados não ganha 600 em cada. O pedido seguinte é `429 RATE_LIMITED` com `Retry-After`; o limite
  roda depois do guard de vínculo, então quem é recusado não gasta o balde (#558).

## A corrida

As duas funções travam o cliente ativo (`FOR SHARE`) antes do conteúdo (`FOR UPDATE`). Aprovar e pedir ajuste do mesmo conteúdo ao
mesmo tempo: um ganha e o outro é `409`. A agência que cancela enquanto o pedido espera: `404` (a rota relê o recorte do portal
quando o banco responde `A0062`). A agência que edita a legenda enquanto a aprovação espera: `409 CONTENT_REVISION_CHANGED`. O arquivamento
do cliente, nas duas janelas (em curso e já confirmado), é `404`, sem gravar nada; o portal nunca fica sabendo que o cliente foi arquivado.

## Erros do banco

`translatePortalError` (`portal-errors.ts`): `A0060`, `A0061` e `A0020` são `404`; `A0062`, `409 CONTENT_NOT_AWAITING_APPROVAL`; `A0063`,
`409 CONTENT_REVISION_CHANGED`; `A0068`, `400 CONTENT_APPROVAL_NOTE_INVALID` ao aprovar e `400 CONTENT_COMMENT_INVALID` nos outros movimentos (o
link do e-mail, que não leva recado, segue com este); `40P01` e `40001`, `409 TRY_AGAIN`; `42501` é relido numa transação
nova (o vínculo ainda vale: `403`, senão `404`). Nenhum erro do banco chega como `500`, e nenhuma resposta leva a mensagem dele.
