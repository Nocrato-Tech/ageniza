# O portal nunca mostra o trabalho interno, e quem garante é a RLS

**Data.** 2026-09-26

**Contexto.** O cliente entra no portal para ver o que agrega valor a ele — calendário, aprovação, relatório, marca —, não o andamento bruto da equipe.

**Decisão.** Regra **pré-decidida para o módulo de Tarefas**: tarefa, responsável interno e prazo interno **nunca são dados do portal**. A garantia é da RLS, não da tela — nenhuma tabela de trabalho interno tem policy que um vínculo de cliente satisfaça.

**Consequência.** Esconder só na interface deixaria o dado alcançável pela API, e o vazamento só apareceria nas ferramentas do navegador de alguém. Quando o portal precisar de um sinal derivado do trabalho interno — "em produção", "atrasado" —, ele é exposto pelo objeto que o cliente enxerga, o conteúdo, nunca pela tarefa.

**Origem.** Decidido em sessão (entrevista do módulo de clientes).

