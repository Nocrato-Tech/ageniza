# Cobrança existe no plano do produto, não no sistema, e tem gatilho
**Data.** 2026-09-24

**Contexto.** `product-overview.md` afirmava que não existe cobrança dentro do sistema. A afirmação está errada quanto à intenção do produto: há a intenção de um modelo de trial e de cobrança por volume — clientes, colaboradores, armazenamento, tarefas, dias, o que se mostrar melhor. Como `AGENTS.md` trata `docs/business/` como autoritativo, um agente lendo aquela frase projetaria ativamente contra cobrança.

**Decisão.** O documento passa a dizer o que é verdade: **cobrança não existe hoje e está prevista**, sem nada desenhado. A **nossa própria agência é isenta**, e a isenção é modelada como estado explícito da agência quando o assunto for desenhado — nunca como ausência de plano, que é o mesmo estado de uma agência inadimplente.

O **gatilho** que obriga a decisão: **a primeira vez que um limite — de clientes, colaboradores ou armazenamento — precisar ser imposto por plano, e não por configuração da operação.** É o único gatilho observável dentro do sistema, e é também o momento mais barato para desenhar, porque `media_assets` já tem quota por agência e o gancho existe.

**Consequência.** Enquanto o gatilho não acontecer, nenhum módulo assume plano, limite comercial ou estado de pagamento. Quando acontecer, assinatura e faturamento entram por definição na lista de capacidades não delegáveis a papel personalizado.

**Origem.** Decidido em sessão (sessão 0 de autorização e transversais).

