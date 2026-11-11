# Todo marco tem uma trilha e uma recompensa

**Data.** 2026-11-11

**Contexto.** A decisão [`2026-11-06-caminho-de-ativacao-e-marcos-da-agencia`](2026-11-06-caminho-de-ativacao-e-marcos-da-agencia.md) criou os primeiros passos e a celebração dos marcos, só no Início da agência. O redesenho de 2026-11-11 quer que qualquer marco do produto se comporte do mesmo jeito, sem que cada tela invente o seu.

**Decisão.**

1. **Duas partes, sempre.** Todo marco tem uma **trilha**, que mostra o que foi feito, o passo atual e o que vem, e uma **recompensa**, que reconhece o passo quando ele acontece.
2. **A trilha muda por estado.** Cada passo é feito, atual ou próximo; ao alcançar um passo, o ponto se preenche, o visto se desenha e a linha corre até o próximo. O passo atual leva o caminho para resolvê-lo. O estado também é dito em palavras, nunca só pelo desenho.
3. **A recompensa é o confete e a mensagem**, no tamanho do marco: grande para a primeira aprovação do cliente, curto para os demais.
4. **As regras de 2026-11-06 continuam, para todo marco:** a recompensa nunca bloqueia a tela nem o clique; quem pede menos movimento recebe só a mensagem (a trilha também aparece já no estado final, sem animação); e tudo é derivado dos dados, sem "marcar como feito" e sem estado novo.

**Consequência.**

- Os componentes são `MilestoneTrail` (a trilha) e `MilestoneCelebration` (a recompensa); a regra de uso mora em `docs/design-system.md`.
- Esta decisão complementa a de 2026-11-06 e não a substitui: quais são os marcos, quando são celebrados e o que fica no navegador seguem como lá.
- Aplicar a trilha às telas é trabalho das telas, em escopos próprios.

**Origem.** O dono do produto, ao aprovar o quadro do redesenho em 2026-11-11.

**Validação.** Pendente de validação do dono.
