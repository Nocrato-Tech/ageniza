# Conteúdo: o card do calendário, o feed e a lista do portal ganham o id do ativo que serve de capa

**Data.** 2026-10-11

**Contexto.** A SPEC (`specs/conteudo.md` §3, §7 e §8) diz que o card do calendário mostra a capa, que o feed é a prévia do Instagram e que "o quadro automático serve de capa quando não há capa enviada". Mas o item da lista por período só traz `coverAssetId`, a capa escolhida, que existe apenas nos formatos que aceitam capa (reels, vídeo longo e VSL). A decisão `2026-10-11-conteudo-feed-da-agencia-grade-do-periodo-e-vista-propria` (item 7) escreve que, "sem capa, o formato aparece como forma": por isso um post de imagem ou de carrossel nunca mostra a imagem no calendário nem no feed, e um reels sem capa escolhida não mostra o quadro automático. A lista do portal (`PortalContentOpenListItem`) tem o mesmo recorte. Só a prévia do modal usa a primeira mídia (issue #606).

**Decisão.**
1. **Um campo novo, `thumbnailAssetId`, no item da lista por período da agência e no item aberto da lista do portal** (a lista do período e a lista do que espera aprovação). Ele é o id do ativo que serve de capa: a capa escolhida; senão, a primeira mídia confirmada e não removida, por posição; `null` quando não há nenhuma. Não é dado novo: é um id de um ativo que a pessoa já lê pelo detalhe.
2. **`coverAssetId` continua sendo só a capa escolhida**, para quem edita (o modal e a prévia). O que serve de capa no card é `thumbnailAssetId`.
3. **O arquivo é sempre pedido como `variant=thumbnail`** à rota de leitura que já existe: imagem devolve ela mesma, e vídeo devolve o quadro gerado. Um vídeo que ainda não tem quadro, ou uma recusa da rota, deixa a forma do formato, como a decisão do feed já diz para a capa.
4. **O portal tem a mesma regra e nunca devolve o id para um conteúdo em produção**: o item "em produção" continua sendo só o título, o dia e o formato. O detalhe do post (`GET .../contents/:contentId`) não repete o campo: a tela do post já tem `media[]`.
5. **A regra mora na API, em dois lugares que têm de andar juntos.** Na agência é a consulta de `apps/api/src/modules/contents/service.ts` (`listPeriod`), que lê `content_media` e `media_assets` (a permissão `conteudo.visualizar` já lê as duas) e põe a capa escolhida na posição 0, antes da mídia. No portal é `app_private.portal_content_media`, a função que decide o que o cliente enxerga, mais a ordenação de `apps/api/src/modules/contents/portal-service.ts` (a capa antes da mídia, depois a posição e o id). Nos dois, um arquivo removido ou não confirmado nunca vira capa. Quem mudar uma das regras muda a outra. O teste da agência é `contents.integration.test.ts` ("the file that serves as the cover of the card"); o do portal é `portal.integration.test.ts` (o mesmo título). Não há migration.

**Consequência.**
- Muda o formato da consulta por período, que Tarefas e Dashboard vão copiar (SPEC §9, item 4). O campo é aditivo; o envelope `{ data, meta }` e os demais campos não mudam.
- A decisão do feed (item 7) não é editada: esta a complementa. A "capa de cada casa" passa a ser a do campo novo, e a forma do formato fica para o conteúdo sem mídia, a recusa da rota e o vídeo sem quadro.
- A tela (outra PR da mesma issue) lê a miniatura só depois de a casa aparecer, e a guarda por ativo.

**Origem.** Issue #606 (auditoria de fechamento do módulo Conteúdo, épico #238), decisão do maestro.

**Validação.** Pendente de validação do dono.
