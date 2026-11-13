# Revisão de segurança por onda, com autoataque do implementador

**Data.** 2026-11-13

**Contexto.** A decisão `2026-11-06-um-pr-por-escopo-com-revisao-por-subtarefa` revisa cada subtarefa de nível Alto separadamente. Medido em 12 e 13/11/2026, no escopo "redesign igual ao quadro": saíram 23 revisões de segurança separadas, cerca de 28% do custo dos agentes, e as subtarefas da camada de banco precisaram de várias rodadas (W10-S3 com 4, W9-S1 e W11-S1 com 3). Cada rodada é uma revisão completa mais uma correção. O dono decidiu mudar a unidade da revisão e mover para o implementador a primeira passada dos ataques.

**Decisão.**

1. A revisão de segurança é **uma por onda**: todas as subtarefas de nível Alto que a onda junta são revisadas numa revisão só, sobre a branch da onda. Para isso, o plano coloca na mesma onda as subtarefas Altas que são independentes entre si.
2. Antes de entregar uma subtarefa de nível Alto, o implementador roda ele mesmo, no seu banco isolado e como `ageniza_app`, os ataques de `docs/security-review.md` que cabem na subtarefa, corrige o que falhar e lista no retorno cada ataque com o comando e o resultado (`autoataque`).
3. A revisão de segurança parte dessa lista: refaz por amostragem o que o implementador diz ter passado e concentra o esforço no que ela não cobre. Continua independente, por outro modelo.
4. O laço segue até zerar os achados de severidade Média e Alta. Da segunda rodada em diante, um achado só de severidade Baixa não abre rodada própria: o implementador corrige, e a conferência vai na revisão da onda seguinte ou, na última onda, na revisão do PR. Na W10-S3, as rodadas 2 a 4 foram revisões completas por um único achado Baixa cada.
5. Teto de três rodadas por onda. Na terceira rodada sem zerar, o maestro para e leva ao dono o que sobrou, a severidade, as rodadas e o custo, e o dono decide: virar issue de débito e seguir, um implementador novo com o resumo, ou mais uma rodada.
6. A implementação continua com o Sonnet. Implementar a camada de banco com o Opus foi considerado e deixado de lado: primeiro se mede o efeito dos itens acima.

**Consequência.** Substitui o item 3 da decisão de 2026-11-06 quanto à unidade da revisão de segurança (era a subtarefa, passa a ser a onda) e quanto ao fim do laço (era zerar todo achado, passa a ser zerar Média e Alta, com Baixa conferida na revisão seguinte e teto de três rodadas). O resto daquela decisão continua valendo, inclusive o PR único por escopo e a publicação da revisão nele. O efeito se mede pelos scripts em `C:/Users/Vidal/agents/medicao/analise-agentes` (revisões de segurança por escopo, rodadas por onda e custo do `security-reviewer`).

**Origem.** Decidido pelo dono do produto em sessão, em 2026-11-13, a partir da auditoria de consumo dos agentes.

**Validação.** Validada pelo dono em 2026-11-13.
