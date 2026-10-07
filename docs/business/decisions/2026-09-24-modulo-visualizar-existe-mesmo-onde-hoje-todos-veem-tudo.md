# `<modulo>.visualizar` existe mesmo onde hoje todos veem tudo
**Data.** 2026-09-24

**Contexto.** A regra do v1 é que todo colaborador enxerga Dashboard, Clientes, Colaboradores e Tarefas. Com essa regra, conceder `visualizar` aos cinco presets em todo módulo do MVP produz linhas que hoje não diferenciam ninguém — e a alternativa era tornar a visibilidade implícita para quem é membro, criando permissão nomeada só nos módulos restritos.

**Decisão.** `<modulo>.visualizar` existe em todo módulo, mesmo quando todos os presets a recebem.

**Consequência.** Evita duas formas concorrentes de decidir visibilidade — implícita para uns, nomeada para outros —, sendo que a primeira escrita viraria a copiada. É `visualizar` que permite, depois, um colaborador ver certas coisas e não outras, e restringir Vendas e Financeiro sem mudar como a autorização é avaliada. O custo é `insert` em migration aditiva.

**Origem.** Decidido em sessão (sessão 0 de autorização e transversais).

