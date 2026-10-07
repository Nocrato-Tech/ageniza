# Remuneração pertence ao Financeiro, que entra no MVP depois de Tarefas
**Data.** 2026-09-24

**Contexto.** A descrição inicial do módulo colocava o salário no crachá, visível para Owner e Financeiro e **não** para o Admin. Isso abria três problemas: RLS no PostgreSQL é por linha e não por coluna, então proteger um campo dentro de `agency_memberships` é frágil; quem convida é o Admin, que não poderia ler o dado que definiria; e a própria descrição vinculava remuneração à "saúde financeira da agência", que é outro módulo.

**Decisão.** A remuneração **nasce no módulo Financeiro**, não em Colaboradores. O crachá do MVP **não mostra salário para ninguém**, inclusive para o Owner, e o espaço é reincluído quando o Financeiro estiver estruturado. Gatilho: **a entrevista do módulo Financeiro**.

O **Financeiro deixa de ser pós-MVP** — o material do Notion o excluía. Ele entra em versão básica, com o que o dono de uma agência precisa para ver saúde do negócio, e sua posição na ordem é **depois de Tarefas, antes do Dashboard**: depende de Clientes para falar de cobrança, e adiantá-lo na frente de Conteúdo inverteria a prioridade do produto.

Três regras já ficam **pré-decididas** para não serem redecididas do zero lá:

- **Quem lê**: o Owner lê todas; quem tem `remuneracao.visualizar` (preset Financeiro) lê todas; **qualquer pessoa lê a própria**, independentemente do papel. O colaborador vê o próprio número — esconder dele removeria a segurança que o dado existe para dar.
- **Onde vive**: tabela própria, nunca coluna em `agency_memberships`. Um `select *` descuidado, uma view ou um `RETURNING` expõem coluna; a RLS decide linha.
- **Histórico**: cada alteração é uma linha com vigência, e o valor atual é a mais recente. Reajuste, promoção e correção são o uso normal; trocar para histórico depois exigiria backfill, que é critério de mudança estrutural.

**Consequência.** O Admin passará a ver a própria remuneração e não a dos outros — a primeira vez que um preset Admin ficará sem uma permissão do catálogo. A ordem de módulos passa a ser: Colaboradores, Clientes, Conteúdo, Tarefas, Financeiro básico, Dashboard.

**Origem.** Decidido em sessão (entrevista do módulo de colaboradores).

