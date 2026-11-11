# ESTRUTURAL: o cliente envia fotos e grava um depoimento pelo portal, ligados ao pedido de material

**Data.** 2026-11-11

**Contexto.** O quadro do redesenho (r0) mostra, no pedido "A agência pediu" do Início do portal, as ações "Enviar fotos", "Gravar depoimento" e "Ver o pedido". Hoje o cliente só responde um pedido de material por **comentário**, e o portal não vê nem envia mídia: a mídia é da agência (`midia.enviar` é permissão da agência, e a política de leitura exige essa permissão). A estrutural "Contexto de cliente na mídia" ([`structural-changes.md`](../structural-changes.md)) ficou fechada por Conteúdo (a mídia tem cliente e pasta), mas o portal continua sem acesso.

**Decisão.**

1. **O cliente envia material, só em resposta a um pedido.** A pessoa ativa do portal envia **fotos** (imagem) e **áudio** (um depoimento gravado no próprio navegador ou um arquivo de áudio) **a um pedido de material aberto do cliente dela**. Não há biblioteca de mídia no portal (continua em aberto, com o gatilho de `specs/conteudo.md`), nem envio sem pedido, nem vídeo ou PDF.
2. **Onde o arquivo cai.** O arquivo vira mídia do cliente, **na pasta "Enviados pelo cliente"** (pasta de sistema do cliente, criada na primeira vez), **ligado ao pedido**. A agência vê o arquivo no pedido (na Visão geral do cliente e em "Pedidos da agência") e na aba Mídias, com "Enviada por <nome do cliente>". O envio comenta o pedido ("enviou 3 fotos"), o que gera a notificação de resposta.
3. **O cliente não apaga nem edita.** Depois de enviado, só a agência remove (remoção lógica, como já é) ou renomeia e move. O cliente nunca lê o arquivo de outra pessoa nem de outro cliente: só os que ele mesmo enviou no pedido.
4. **Limites.** Imagem e áudio só (tipos de [`2026-11-11-estrutural-a-midia-aceita-pdf-audio-e-svg-como-logo`](2026-11-11-estrutural-a-midia-aceita-pdf-audio-e-svg-como-logo.md), **sem SVG**); teto de tamanho por arquivo e de quantidade por pedido (a proposta é 25 MB e 20 arquivos, a confirmar na SPEC e no PR); contam na **cota de armazenamento da agência**.
5. **Neutro com a cobrança da agência.** Com a cota estourada ou a agência em somente leitura, o portal mostra a mensagem neutra de [`2026-11-06-portal-nao-expoe-a-cobranca-da-agencia`](2026-11-06-portal-nao-expoe-a-cobranca-da-agencia.md) ("A aprovação está pausada no momento…"), nunca plano, cota nem cobrança.
6. **Pedido resolvido ou cliente arquivado não recebem envio.**

**Substitui.**

- A decisão [`2026-09-18-midia-e-escopada-por-agencia-sem-vinculo-com-cliente`](2026-09-18-midia-e-escopada-por-agencia-sem-vinculo-com-cliente.md) (a mídia é só da agência) e a linha "Contexto de cliente na mídia" de [`structural-changes.md`](../structural-changes.md), no que dizia que o portal "não vê mídia nenhuma, nem a própria": o portal passa a ler e a enviar **a própria mídia do pedido**.
- O item 2 de [`2026-11-10-estrutural-pedido-de-material-e-assunto-proprio-da-conversa-do-cliente`](2026-11-10-estrutural-pedido-de-material-e-assunto-proprio-da-conversa-do-cliente.md), "o cliente responde por comentário", que passa a "por comentário **ou por arquivo**".

**Consequência.**

- **É estrutural:** muda a RLS de `media_assets` (o vínculo de cliente passa a poder `INSERT` e `SELECT` em mídia do próprio pedido) e **muda como a autorização é avaliada** (o portal passa a ter caminho de escrita em mídia). **Migration** nova: coluna do pedido em `media_assets` (anulável, chave estrangeira para a conversa) e a marca de quem enviou (agência ou cliente); policies novas e a pasta de sistema; função de envio que confere pedido aberto, cliente ativo e agência que aceita escrita. **Sem backfill.**
- **Risco: Alto**, o mais alto desta onda: storage, portal com autorização, arquivo de terceiro numa conta da agência e cota. Pede revisão de segurança independente com ataque real: a pessoa do portal **de outro cliente, da mesma agência ou de outra** não envia nem lê; um pedido de outro cliente ou resolvido é recusado; o tipo declarado diferente do real, SVG e arquivo acima do limite são recusados; a URL de leitura do portal só alcança o arquivo que a pessoa enviou; o envio estoura a cota sem vazar plano; mutações em cada policy e em cada função.
- O fluxo mobile do portal descreve o envio.

**Origem.** Resposta do dono do produto em 2026-11-11 (upload pelo cliente no portal, ligado ao pedido de material, risco Alto) e decisão do maestro sobre a pasta, os tipos e a cota (risco 11 do inventário).

**Validação.** Pendente de validação do dono.
