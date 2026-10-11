# A URL de leitura da mídia de cliente segue `conteudo.visualizar`

**Data.** 2026-10-11

**Contexto.** A decisão `2026-10-07-biblioteca-de-midia-do-cliente-regras-da-api` deixou a URL de leitura (`GET /agencies/:agencyId/media/:assetId/download-url`) fora da #253: ela exigia `midia.enviar`, que só o Admin tem. Gestor e Produção, que leem a biblioteca do cliente com `conteudo.visualizar`, não conseguiam assinar a capa do calendário (#262), a miniatura das Pastas (#267) nem a mídia do modal (#264). A migration `20261007000900` já fez a leitura de `media_assets` seguir a permissão certa por linha: sem cliente, `midia.enviar`; com cliente, `conteudo.visualizar`.

**Decisão.**
1. **A rota aceita `midia.enviar` ou `conteudo.visualizar`**, e a RLS de `media_assets` decide o que cada papel lê. A mídia com cliente exige `conteudo.visualizar`; a mídia sem cliente continua com `midia.enviar`. A mídia que o papel não lê é o mesmo 404 da ausente, nunca um 403 que confirme que ela existe. Vendas e Financeiro, que não têm nenhuma das duas, recebem 403; quem tem só `conteudo.operar` também.
2. **Mídia removida (`removed_at`), pendente, rejeitada ou de outra agência é 404** em qualquer variante, sem assinar nada e sem auditar.
3. **`variant=thumbnail` de imagem devolve o original**: nenhuma miniatura é gerada para imagem, e o original serve no MVP. De vídeo, devolve a miniatura gerada; antes de processada é `409 VARIANT_NOT_READY` (e `VARIANT_PROCESSING_FAILED` após falha terminal), o código que a tela trata com um marcador. `preview` de imagem segue 409 `VARIANT_NOT_READY`.
4. **O portal não usa esta rota.** Quem só tem vínculo de cliente não passa do guard de agência.

**Consequência.**
- Quem lê Conteúdo passa a assinar todo original do cliente da própria agência, não só a miniatura: a URL do original é a mesma que a da miniatura de imagem. Quem só lê, pois, baixa o arquivo de produção. Se o dono quiser separar "ver" de "baixar", é uma permissão nova e uma variante reduzida gerada para imagem.
- Cada URL assinada grava `media.download_url_issued` com o ator. Uma tela que assina uma capa por card gera uma linha por card; o volume é decisão da tela (cache da URL até `expiresAt`) ou de uma regra de auditoria que a SPEC ainda não tem.
- A rota de download não tem o limite de taxa das rotas de upload (`signedUrlIssuance`), e a lista de capas de um mês pode chamá-la dezenas de vezes. Limitar é decisão à parte.
- Não há migration: a RLS e as colunas já existiam.

**Origem.** Issue #550, achado da Âncora no #544 (#262) e pendência da decisão de 2026-10-07.

**Validação.** Pendente de validação do dono.
