# Escopo do módulo de colaboradores
**Data.** 2026-09-24

**Contexto.** Primeira entrevista conduzida pelo bloco 0, a pergunta aberta de fluxo. Ela levantou cinco capacidades que o backend não tem — foto de perfil, remuneração, estatísticas do colaborador, edição do próprio nome e solicitação de troca de e-mail — e três delas mudavam o tamanho do módulo.

**Decisão.** O módulo cobre: **listar a equipe** em grade de crachás com busca e filtros, **ver o detalhe** de uma pessoa num modal com abas, **convidar** colaborador, **reenviar e cancelar** convite, **remover** do quadro e **reativar**, **trocar o papel** de alguém, **editar o cargo** de alguém, e **editar o próprio nome e a própria foto**.

Fica fora, com razão declarada:

- **Remuneração** — vai para o módulo Financeiro; ver a decisão seguinte.
- **Estatísticas do colaborador** (entregas, pendências) — não há o que contar antes de Tarefas existir. O modal nasce com a estrutura de abas e a área reservada. Gatilho: a primeira entrevista que criar tarefa atribuível a colaborador.
- **Pré-cadastro no convite** — o convite leva e-mail e `role_id`, e nada mais. Guardar cargo ou remuneração de um convite pendente exigiria alterar `invitations`, cuja policy de `UPDATE` é deliberadamente restrita a `revoked_at` (issue #39); dado editável de RH ali obrigaria a afrouxar aquela trava.
- **Solicitação de troca de e-mail** — a tela informa que a troca é feita pela operação, e a conversa acontece fora do produto. Criar uma fila de solicitações, com estado e notificação, para um evento raro cujo desfecho é alguém rodando um comando não se paga. Volta à mesa quando a troca de e-mail for destravada.
- **Telefone e qualquer campo além dos definidos** — o vínculo carrega nome, foto, e-mail, cargo, papel e data de entrada. Nada mais no MVP.

**Consequência.** Nenhuma tabela nova e nenhuma coluna nova: `job_title` já existe em `agency_memberships`, e `image` já existe em `auth."user"`. O que falta é policy, rota e tela.

**Origem.** Decidido em sessão (entrevista do módulo de colaboradores).

