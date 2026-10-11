# A URL de leitura da mídia de cliente segue `conteudo.visualizar`

**Data.** 2026-10-11

**Contexto.** A decisão `2026-10-07-biblioteca-de-midia-do-cliente-regras-da-api` deixou a URL de leitura (`GET /agencies/:agencyId/media/:assetId/download-url`) fora da #253: ela exigia `midia.enviar`, que só o Admin tem. Gestor e Produção, que leem a biblioteca do cliente com `conteudo.visualizar`, não conseguiam assinar a capa do calendário (#262), a miniatura das Pastas (#267) nem a mídia do modal (#264). A migration `20261007000900` já fez a leitura de `media_assets` seguir a permissão certa por linha: sem cliente, `midia.enviar`; com cliente, `conteudo.visualizar`.

**Decisão.**
1. **A rota aceita `midia.enviar` ou `conteudo.visualizar`**, e a RLS de `media_assets` decide o que cada papel lê. A mídia com cliente exige `conteudo.visualizar`; a mídia sem cliente continua com `midia.enviar`. A mídia que o papel não lê é o mesmo 404 da ausente, nunca um 403 que confirme que ela existe. Vendas e Financeiro, que não têm nenhuma das duas, recebem 403; quem tem só `conteudo.operar` também.
2. **Mídia removida (`removed_at`), pendente, rejeitada ou de outra agência é 404** em qualquer variante, sem assinar nada e sem auditar.
3. **`variant=thumbnail` de imagem devolve o original**: nenhuma miniatura é gerada para imagem, e o original serve no MVP. De vídeo, devolve a miniatura gerada; antes de processada é `409 VARIANT_NOT_READY` (e `VARIANT_PROCESSING_FAILED` após falha terminal), o código que a tela trata com um marcador. `preview` de imagem segue 409 `VARIANT_NOT_READY`.
4. **O portal não usa esta rota.** Quem só tem vínculo de cliente não passa do guard de agência.
5. **Só o pedido do original grava auditoria** (`media.download_url_issued`, com o ator). O pedido de `thumbnail` e o de `preview`, que são o que as capas do calendário, as Pastas e o modal usam, não gravam o evento, mesmo quando a miniatura de imagem é o original assinado: o que se audita é o download explícito, não a renderização. Decisão do maestro de 2026-10-11, pendente de validação do dono.

**Consequência.**
- Quem lê Conteúdo passa a assinar todo original do cliente da própria agência, não só a miniatura: a URL do original é a mesma que a da miniatura de imagem. Quem só lê, pois, baixa o arquivo de produção. Se o dono quiser separar "ver" de "baixar", é uma permissão nova e uma variante reduzida gerada para imagem.
- Quem lê Conteúdo pode obter o original de imagem pela variante `thumbnail` sem deixar rastro de auditoria; só o pedido explícito de `original` aparece na trilha. Se o dono quiser rastrear quem baixou o arquivo de produção, a saída é a variante reduzida gerada para imagem, e então a auditoria volta a valer para o original.
- A rota de download não tem limite de taxa próprio: o `signedUrlIssuance` das rotas de upload não a cobre, e o plugin de rate limit da API é `global: false`, então não há limite geral que valha para ela. A lista de capas de um mês pode chamá-la dezenas de vezes. Limitar é decisão à parte, e fica como está. A revisão de segurança do PR #553 classificou a ausência de limite como Média; o limite por usuário é o follow-up #558.
- Não há migration: a RLS e as colunas já existiam.

**Origem.** Issue #550, achado da Âncora no #544 (#262) e pendência da decisão de 2026-10-07.

**Validação.** Pendente de validação do dono.
