# O portal assina a mídia do conteúdo que ele vê

**Data.** 2026-10-11

**Contexto.** O `GET /clients/:clientId/contents/:contentId` do portal (#257) devolve `media[{ id, position }]` e `coverAssetId` sem endereço, e a única rota que assina mídia (`GET /agencies/:agencyId/media/:assetId/download-url`, #553) é de agência: quem só tem vínculo de cliente não passa do guard dela (`2026-10-11-url-de-leitura-da-midia-de-cliente-por-conteudo-visualizar`, item 4). Sem uma rota própria, a tela de Conteúdos do portal (#270) não mostra a capa nem a mídia que a pessoa precisa conferir para aprovar.

**Decisão.**
1. **Rota nova do portal:** `GET /clients/:clientId/contents/:contentId/media/:assetId/url?variant=original|thumbnail`, sob sessão e vínculo ativo com o cliente. Não há migration: a leitura é a função `app_private.portal_content_media`, que já existe.
2. **Assina só o que o portal lê.** O conteúdo é do cliente do endereço e está de "aguardando aprovação" em diante; o arquivo é a capa ou um item da mídia desse mesmo conteúdo, confirmado e não removido. Conteúdo em produção, cancelado, de outro cliente (mesmo de um que a pessoa também lê), de outra agência ou inexistente é `404 Content not found.`; arquivo removido, não confirmado, de outro conteúdo ou inexistente é `404 Media asset not found.`. Nada é assinado nem auditado nesses casos, e a pessoa que também é colaboradora da agência recebe o mesmo recorte.
3. **A chave do original não sai da tabela.** Ela é montada com a agência que o guard provou para o cliente, o id do arquivo e a extensão que a função devolve, a forma que a própria tabela impõe por constraint (`agency_id/asset_id/original.extensão`). A função de leitura continua sem devolver a chave.
4. **Variantes.** `original` (o padrão) assina o arquivo e grava a auditoria `media.download_url_issued`, com a pessoa da sessão e a agência do cliente. `thumbnail` devolve o próprio original para a imagem e a miniatura gerada para o vídeo, sem auditoria, como na agência (#553); enquanto o vídeo não foi processado, `409 VARIANT_NOT_READY`, e após falha terminal, `409 VARIANT_PROCESSING_FAILED`, sem o motivo que o worker gravou. A variante `preview` do vídeo não é oferecida ao portal.
5. **Sem limite de taxa próprio**, como a rota da agência: o limite por usuário é o follow-up #558 e vale para as duas.

**Consequência.**
- A pessoa do portal baixa o original de um arquivo de produção que a agência subiu: a miniatura de imagem é o original, e o original de vídeo é o único jeito de assistir o vídeo inteiro no portal enquanto o `preview` não é oferecido. Se o dono quiser separar "ver" de "baixar", a saída é a variante reduzida gerada para imagem e a oferta do `preview` ao portal.
- Quem só pede `thumbnail` de imagem obtém o original sem deixar rastro de auditoria; só o pedido explícito de `original` aparece na trilha.
- A resposta é `{ url, expiresAt }`, o mesmo contrato da rota da agência, sem nenhum id interno a mais.

**Origem.** Issue #584, achado do Cardume na #270. No item 4, a variante `preview` fora do portal e a ausência do motivo do worker são decisões do implementador, tomadas aqui por não estarem na issue; a auditoria e o limite seguem o que a issue manda (#553 e #558).

**Validação.** Pendente de validação do dono.
