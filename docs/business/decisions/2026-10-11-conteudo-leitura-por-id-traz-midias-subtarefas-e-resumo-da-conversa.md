# Conteúdo: a leitura por id traz as mídias, as subtarefas e o resumo da conversa

**Data.** 2026-10-11

**Contexto.** A SPEC (`specs/conteudo.md` §6) diz que `GET .../contents/:contentId` devolve "o conteúdo com mídias, subtarefas e o resumo da conversa", sem dizer o que cada parte traz. As subtarefas só ganham rotas de escrita na #255, e a conversa do conteúdo reaproveita as rotas de conversa do cliente (com `content_id`).

**Decisão.**
1. **O conteúdo completo**: todas as colunas que a agência lê, inclusive `caption`, `revision`, `approvedBy`, `approvedAt`, `approvedByAgencyReason`, `publishedOn` e `cancelledAt`. O que o portal nunca vê (responsável, motivo de "aprovado fora", quem aprovou) vem, porque esta é a rota da agência.
2. **`media`**: cada mídia do conteúdo como `{ id, position }`, na ordem das posições. O `id` é o da mídia; a URL assinada é da rota de mídia, não desta.
3. **`tasks`**: as subtarefas, **só leitura**: `id`, `title`, `description`, `assigneeUserId`, `dueOn`, `status`, `returnComment`, `approvedBy` e `approvedAt`, por prazo, criação e `id`. Não há rota de escrita aqui (é a #255).
4. **`conversation`**: o resumo `{ threadId, commentCount, lastCommentAt }` da conversa do conteúdo. Enquanto ninguém abriu a conversa, `threadId` e `lastCommentAt` são `null` e `commentCount` é 0. Os comentários em si vêm das rotas de conversa do cliente.
5. **A mesma forma** (`ContentDetailSchema`) é a resposta de `POST` e `PATCH`, para a tela reabrir o modal sem uma segunda leitura.
6. Um conteúdo de outro cliente, de outra agência, ou que não existe responde o mesmo `404`; quem não tem `conteudo.visualizar` responde `403`. O cliente arquivado também responde.

**Consequência.**
- A lista de subtarefas não tem teto nem paginação nesta leitura; quando a #255 limitar quantas subtarefas um conteúdo tem, o limite entra lá.
- O resumo da conversa conta o que a agência lê da tabela de comentários; se a tela precisar do último autor, é acréscimo ao resumo.

**Origem.** Issue #254, decidido pelo maestro a pedido do implementador.

**Validação.** Pendente de validação do dono.
