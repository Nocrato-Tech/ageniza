# Preset de papel é preenchido na entrevista do módulo, não antecipadamente
**Data.** 2026-09-24

**Contexto.** Existem cinco papéis de sistema, e quatro deles — `account_manager`, `production`, `sales` e `finance` — estão com **zero permissões**: hoje não podem fazer nada. Preencher todos agora exigiria decidir permissões de Pipeline e Financeiro, que o próprio material do Notion tirou do MVP.

**Decisão.** Cada entrevista de módulo fecha a linha de preset do seu módulo: os cinco papéis e o que cada um pode ali. A SPEC de um módulo **não está completa sem essa linha**, e `specs/TEMPLATE.md` cobra isso na seção 2.

**Consequência.** Nenhum papel além de Admin ganha capacidade por antecipação, e o preset deixa de ser decidido no vácuo. O risco é preset esquecido por omissão; o template é o que impede. Enquanto um módulo não for entrevistado, os papéis continuam sem permissão nele — ver a decisão sobre presets vazios.

**Origem.** Decidido em sessão (sessão 0 de autorização e transversais).

