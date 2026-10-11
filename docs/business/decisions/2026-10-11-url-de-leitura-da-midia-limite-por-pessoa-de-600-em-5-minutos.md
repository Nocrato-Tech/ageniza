# A URL de leitura da mídia tem limite por pessoa: 600 pedidos em 5 minutos

**Data.** 2026-10-11

**Contexto.** A decisão `2026-10-11-url-de-leitura-da-midia-de-cliente-por-conteudo-visualizar` (item 5) deixou o pedido de `thumbnail` sem auditoria, e a miniatura de uma imagem é o próprio original assinado. A revisão de segurança do PR #553 (Garça) classificou como Média a ausência de limite na rota: um papel com `conteudo.visualizar` baixa originais em massa sem rastro (200 pedidos deram 20 originais, 0 auditorias e 0 respostas 429). O `signedUrlIssuance` cobre só as rotas de upload e conta por IP; o plugin de limite da API é `global: false`, então nenhum limite geral vale para `GET /agencies/:agencyId/media/:assetId/download-url`.

**Decisão.**
1. **A rota passa a ter limite por pessoa:** 600 pedidos a cada 5 minutos, em janela fixa, de qualquer variante (`original`, `thumbnail`, `preview`), de qualquer agência e **das duas rotas que assinam a leitura**: a da agência (`download-url`) e a do portal (`GET /clients/:clientId/contents/:contentId/media/:assetId/url`, #584). O pedido 601 é `429 RATE_LIMITED` com `Retry-After` (segundos até o fim da janela).
2. **A chave é a pessoa da sessão**, não o IP e não a agência. Um colega da mesma agência, atrás do mesmo endereço, tem o balde dele; a pessoa com vínculo em duas agências tem um balde só, e o limite não se multiplica pelo número de agências.
3. **Não há limite por agência.** Ele faria um usuário esgotar a mídia dos colegas (o limite de uma pessoa não pode afetar outra), e o limite por pessoa já limita a agência pelo número de contas dela. Quem controla várias contas da mesma agência já é um problema de conta, não de taxa.
4. **O limite roda depois dos guards de sessão, agência e permissão, e antes da consulta.** O pedido recusado por guard (401, 403) não gasta o balde de ninguém; o 429 não consulta, não assina e não audita. O pedido que dá 404 (mídia ausente, removida, de outra agência) gasta o balde, o que também limita a enumeração de ids.
5. **Os números vêm da tela.** A janela de 5 minutos é a validade da URL assinada (300 s); a capa guarda a URL por asset até 30 s antes de ela expirar, então cada asset é pedido, no uso normal, no máximo uma vez por janela. A pior sequência realista numa janela é: dois meses de capas (2 × 100; um mês de até três posts por dia dá cerca de 93; o teto do período na API é 500, mas a capa só é pedida quando o cartão entra na tela), três páginas de pastas de 48 miniaturas e dois carrosséis de 20 mídias: 384 pedidos. 600 é cerca de 1,56 vez isso. O teste fixa esses valores e a sequência.
6. **Um balde só para as duas rotas, e não uma cópia da configuração.** O plugin de limite cria um store para cada rota que declara limite: os mesmos números em duas rotas seriam dois baldes, e a pessoa que é colaboradora e também lê pelo portal ficaria com 600 em cada. Por isso as duas rotas recebem o mesmo handler (`sharedUserRateLimit`, um store e a mesma chave por usuário), e o 429 de uma vale para a outra. No portal o limite roda depois do guard de vínculo, como na agência: quem o guard recusa não gasta o balde. A decisão `2026-10-11-portal-assina-a-midia-do-conteudo-que-ve` deixou o limite para a #558.

**Consequência.**
- **O limite é um freio, não uma cota.** 600 a cada 5 minutos são até 7.200 por hora: uma sessão tomada ainda baixa originais de imagem pela variante `thumbnail` sem auditoria, só que mais devagar e com 429 e linha de log quando passa do ritmo da tela. O que fecha o buraco é o que a decisão de origem já nomeou: uma variante reduzida gerada para imagem, e então a auditoria volta a valer para o original. O exemplo do achado (200 pedidos) continua dando 200 respostas, não 429.
- A janela é fixa: na virada dela, uma pessoa consegue até 1.200 pedidos em poucos segundos.
- O contador mora na memória do processo da API: reiniciar zera, e com mais de uma instância cada uma conta a sua. É o mesmo comportamento dos demais limites da API.
- Quando uma pessoa estoura, a capa e a miniatura voltam ao marcador da forma (a tela trata qualquer recusa assim, e um 429 não é repetido, porque só falha de servidor é repetida), e se recupera sozinha no fim da janela.
- **Pendência de tela, em PR separado:** `MediaThumbnail` (miniatura das Pastas) usa o `staleTime` padrão de 30 s, e não o da validade da URL como `ContentCover`; reabrir a mesma pasta de 48 mídias depois de 30 s gasta 48 pedidos de novo. Dentro do limite para o uso normal (10 reaberturas numa janela são 480), mas desperdiça o balde.
- Não há migration.

**Origem.** Issue #558, ressalva Média da Garça na revisão de segurança do #553 e decisão `2026-10-11-url-de-leitura-da-midia-de-cliente-por-conteudo-visualizar`.

**Validação.** Pendente de validação do dono.
