# Conteúdo: impacto estrutural

**Data.** 2026-10-01

**Esta é uma mudança estrutural.** Confrontado item por item com `structural-changes.md`, Conteúdo altera tabelas existentes, mexe em RLS de mais de um módulo, muda como a autorização é avaliada, cria formatos que outros módulos vão copiar e exige backfill.

**Contexto.** Bloco 7 da entrevista de Conteúdo.

**Decisão.**
1. **Mídia com cliente e pasta.** `media_assets` ganha cliente e pasta, e entram as tabelas de pastas (padrão e de trabalho). O portal lê mídia **só através do conteúdo** que já pode ver. A mídia anterior, sem cliente, continua só da agência. Fecha a estrutural pendente "cliente na mídia" (2026-09-26) na forma **por pasta do cliente, lida pelo conteúdo**.
2. **A conversa ganha `content_id`**, como anunciado em 2026-09-26. O portal só comenta a partir de "aguardando aprovação", regra que entra na policy de insert dos comentários.
3. **Aprovação por atribuição.** Aprovar subtarefa depende de ser o responsável do conteúdo; quem tem `conteudo.aprovar_pela_agencia` substitui. Segue o formato de autorização dependente do valor (o mesmo de "só o Owner concede admin"): regra no banco, por função ou trigger, nunca um `if` na rota.
4. **Consulta por período.** Calendário e feed consultam por intervalo de datas (`de`/`até`), com teto de 93 dias e teto de itens (400 acima disso), sem paginação. É o formato que Tarefas (kanban) e Dashboard vão copiar; a listagem paginada continua valendo para listas.
5. **Trabalho sem requisição.** O envio de e-mails e o cancelamento de conteúdo além da data de encerramento usam funções `security definer` de escopo único, no molde de `archive_due_clients`. O cancelamento entra **na própria função de arquivar o cliente**, para arquivar e cancelar acontecerem juntos.
6. **Backfill das pastas padrão.** A migration cria as pastas padrão para os clientes existentes; o cadastro de cliente passa a criá-las para cada cliente novo.
7. **Fila de notificação.** O e-mail de Conteúdo é o primeiro mecanismo de notificação, desenhado como fila (destinatário, tipo, cliente, janela de agrupamento) enviada pelo worker, para os próximos tipos entrarem sem refazer. Preferências e notificação dentro do produto continuam em aberto.

**Consequência.** A implementação começa pelas migrations e pelas funções de banco (pastas, mídia, conteúdo, subtarefas, estados, conversa), depois as rotas, depois as telas; cada migration em PR próprio, com o gate de decisão estrutural. Depende de #122, #123 e #128 mergeadas.

**Origem.** Decidido pelo dono do produto em sessão (entrevista do módulo Conteúdo), em 2026-10-01.

