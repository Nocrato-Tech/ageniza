# A entrevista abre por uma pergunta de fluxo, antes de qualquer rodada
**Data.** 2026-09-24

**Contexto.** O roteiro põe UX no sétimo lugar, de propósito: tela desenhada antes de estado definido inventa estado. Mas a entrevista de autenticação mostrou o efeito colateral. As capacidades que o backend não tinha — troca de senha por quem está logado, troca de e-mail — só apareceram quando a conversa chegou perto das telas, depois de a sessão já ter decidido escopo em cima do que existia. Quem conduz gastou a sessão inteira raciocinando sobre o implementado, e o que faltava chegou atrasado.

**Decisão.** A entrevista abre com uma **pergunta aberta sobre o fluxo**: como o módulo deve funcionar na prática, e quais telas quem usa imagina. Uma pergunta, ampla, sem opções numeradas — conversa, não rodada. O que ela colhe é **intenção e inventário de telas**, nunca layout e nunca decisão fechada; os sete blocos seguintes refinam aquilo contra os contratos e as regras que já existem.

Quando a resposta revelar algo que a API não faz, quem conduz diz isso na hora e trata como **capacidade nova** — escopo a decidir, não detalhe de tela.

**Consequência.** UX continua sendo o sétimo bloco, e continua fechando o esboço: o bloco 0 levanta as telas, o bloco 6 as desenha. O risco que isso cria é a abertura virar desenho antecipado, e é por isso que ela é explicitamente sem layout. O que se ganha é a chance de acrescentar algo que o backend não tem enquanto ainda é barato decidir.

**Origem.** Decidido em sessão, a partir da entrevista do módulo de autenticação.

