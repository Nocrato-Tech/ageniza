# A navegação da agência não mostra "Ajustes" enquanto a tela não existe

**Data.** 2026-10-14

**Contexto.** A issue #628 e o canvas do redesign Pauta desenham a navegação lateral com os grupos Trabalho (Início, Conteúdos, Clientes) e Agência (Equipe, Ajustes). Hoje não existe rota nem tela de ajustes da agência, e o épico #621 proíbe tela com função nova. A rota de colaboradores já existe e se chama "Colaboradores" na navegação e no título da tela.

**Decisão.**
1. O item "Ajustes" não aparece na navegação até existir uma tela para ele: um link sem destino é um controle que não funciona (docs/design-system.md, seção 23). O grupo Agência mostra só "Equipe" e some quando a pessoa não tem `colaborador.visualizar`.
2. O item da rota `/agencia/:agenciaId/colaboradores` passa a se chamar "Equipe" na navegação, como no canvas. O título da tela e o atalho da página inicial continuam "Colaboradores" até a task da Equipe (#638) renomear a tela.
3. A navegação abre recolhida (trilho de 80px) no calendário de um cliente e aberta nas demais telas; a escolha explícita da pessoa vale até recarregar a página.

**Consequência.** Quando a tela de ajustes existir, o item entra no grupo Agência no mesmo PR que a cria. Até a #638, a mesma rota tem dois nomes (Equipe na navegação, Colaboradores na tela).

**Origem.** Issue #628, épico #621; canvas do redesign Pauta.

**Validação.** Pendente de validação do dono.
