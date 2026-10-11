# O portal informa se cada item da mídia do post é imagem ou vídeo

**Data.** 2026-10-11

**Contexto.** O `GET /clients/:clientId/contents/:contentId` do portal devolvia `media[{ id, position }]` sem o tipo do arquivo, e o formato `carrossel` aceita imagem e vídeo. A tela do post (#270) precisava adivinhar: tentava imagem e, no erro, vídeo (`2026-10-11-portal-post-em-tela-cheia-aprovar-pedir-ajuste-e-midia`, item 4).

**Decisão.** Cada item de `media[]` do post do portal ganha `kind`, `image` ou `video`, lido da categoria do arquivo pela função `app_private.portal_content_media` que a rota já usa. A capa não é item de `media[]` (é `coverAssetId`, pedida como `variant=thumbnail`, sempre imagem), então não ganha o campo. O contrato continua estrito e não há migration.

**Consequência.** O campo é aditivo e só existe no item de mídia do portal: não muda o formato de resposta que outras rotas copiam (a lista por período, o envelope `{ data, meta }` e as respostas da agência ficam como estão). Quem lê o post do portal passa a receber `kind` em todo item.

**Origem.** Decisão do maestro sobre a limitação apontada no PR #600 (issue #270).

**Validação.** Pendente de validação do dono.
