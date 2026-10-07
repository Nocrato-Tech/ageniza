# Conteúdo: regras invioláveis

**Data.** 2026-10-01

**Contexto.** Bloco 5 da entrevista de Conteúdo. Cada regra vira teste e é garantida no banco, não só na tela.

**Decisão.**
1. O portal nunca vê trabalho interno: subtarefas, responsável, prazos internos, conteúdo em produção além de título, data e tipo, e roteiro em rascunho.
2. O portal só vê o próprio cliente; quem não tem `conteudo.visualizar` não vê conteúdo algum, nem pela API.
3. Conteúdo, pasta e mídia são sempre do mesmo cliente e da mesma agência; o conteúdo só seleciona mídias da própria pasta.
4. Quem aprovou e quando é fixado pelo banco. Aprovar é de pessoa ativa do portal daquele cliente, ou "aprovado fora" com a permissão e motivo.
5. Só as transições decididas existem.
6. Mudar legenda, mídia, capa ou tipo depois de aprovado anula a aprovação.
7. Publicado só a partir de aprovado, com data real não futura; desfazer só no mesmo dia.
8. Cliente arquivado não recebe conteúdo novo e não dispara e-mail; o agendado depois do encerramento vira cancelado e não volta sozinho. Agência suspensa não dispara e-mail.
9. Conteúdo não é apagado: cancelado continua guardado.
10. Responsável de subtarefa é colaborador ativo; só o responsável do conteúdo, Admin ou Gestor de conta aprovam subtarefa.
11. Enviar para aprovação exige mídia completa e subtarefas aprovadas; pedir ajuste exige comentário.
- **Mídia** pode ser removida da pasta enquanto nenhum conteúdo aprovado ou publicado a usa; a remoção marca como removida e o arquivo sai pelo fluxo de retenção.
- **O cliente comenta** só a partir de "aguardando aprovação".
- **Conteúdo de cliente arquivado** fica visível só para leitura na agência.

**Consequência.** As transições e a anulação da aprovação precisam de função ou trigger no banco, no molde do `BEFORE UPDATE` com OLD/NEW já adotado.

**Origem.** Decidido pelo dono do produto em sessão (entrevista do módulo Conteúdo), em 2026-10-01.

