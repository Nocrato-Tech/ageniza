# Remuneração fica fora do MVP

**Data.** 2026-10-07

**Contexto.** A #109 perguntava se, e como, a remuneração aparece no crachá e no modal de colaboradores. A decisão de 2026-09-24 ("Remuneração pertence ao Financeiro, que entra no MVP depois de Tarefas") já tirou o salário de Colaboradores e deixou o espaço reservado para quando o Financeiro existisse.

**Decisão.** A remuneração fica **fora do MVP**. É dado sensível (LGPD), exige regra própria de quem vê e não é necessária para operar a agência agora. Hoje ela não aparece em lugar nenhum, e `apps/web/src/collaborators.test.tsx` garante que o modal não mostra salário nem remuneração. Volta como módulo próprio (financeiro), com SPEC, quando o dono pedir. As três regras pré-decididas em 2026-09-24 (quem lê, tabela própria, histórico) continuam como ponto de partida e não são redecididas do zero.

**Consequência.** A linha "Remuneração no crachá e no modal" da seção 10 de `specs/colaboradores.md` segue listada, mas o gatilho passa a ser o pedido do dono, e não a entrevista do Financeiro; a SPEC não foi reescrita neste PR, e esta entrada prevalece sobre ela. Esta decisão restringe a de 2026-09-24 só na parte da remuneração: se o Financeiro básico continua no MVP depois de Tarefas não é tratado aqui e fica a cargo do dono.

**Origem.** Decisão do maestro, com autonomia dada pelo dono em 2026-10-07, registrada no fechamento da issue #109. Validada pelo dono em 2026-10-08.

