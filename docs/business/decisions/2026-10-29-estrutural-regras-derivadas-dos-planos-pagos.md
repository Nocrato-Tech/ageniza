# ESTRUTURAL: o que a implementação dos planos pagos decidiu onde a decisão do dono não dizia

**Data.** 2026-10-29

**Contexto.** A decisão de 2026-10-29 ([planos pagos, assinatura e gateway simulado](2026-10-29-estrutural-planos-pagos-assinatura-e-gateway-simulado.md)) fixa os planos, os extras, as mudanças e o cancelamento, e não diz como contar o período, o proporcional, a renovação nem o que acontece nos casos de borda. Ao desenhar o banco (#771), cada ponto precisou de uma leitura exata. Cada uma foi escolhida pelo caminho mais restritivo ou mais simples, e nenhuma muda o que o dono decidiu.

**Decisão.**

1. **GB é GiB.** Os 20, 100 e 300 GB dos planos e cada GB de extra valem 1 073 741 824 bytes, como os 2 GB do trial valem 2 GiB (decisão de 2026-10-27).
2. **O período é de um mês de calendário** a contar da assinatura. A renovação começa onde o período anterior terminou, inclusive a que chega dentro da tolerância do item 8, para que os dias da tolerância sejam pagos; a que chega depois da tolerância começa no instante dela.
3. **O proporcional conta dias inteiros.** Subir cobra a diferença do preço mensal vezes os dias que faltam, contando como inteiro o dia começado, sobre os dias do período, arredondada ao centavo. Quando o novo total é menor que o atual com tetos maiores, a cobrança é zero e não há estorno.
4. **Subir ou descer se decide pelos tetos**, não pelo preço: se o teto de clientes e o de armazenamento ficam iguais ou maiores, é subir; se ficam iguais ou menores, é descer. Aumentar um teto e reduzir o outro na mesma mudança é recusado, para a pessoa fazer uma coisa por vez. Mesmos tetos com preço menor esperam o período seguinte; mesmos tetos com o mesmo preço não mudam nada e são recusados.
5. **O uso que o novo teto não pode ficar abaixo** é o de clientes ativos e o de armazenamento confirmado e ainda não expurgado. Um teto igual ao uso é aceito. O mesmo vale para a primeira assinatura.
6. **Descida agendada que já não cabe na renovação** (a agência cresceu até o teto antigo depois de agendar) fica sem efeito: a renovação mantém o plano atual, não reduz abaixo do uso, e o fato fica registrado. A agência pode agendar de novo.
7. **A renovação é cobrada a partir de um dia antes do fim do período**, e uma agência com a assinatura cancelada não é renovada.
8. **Tolerância de 3 dias, só para quem não cancelou.** Terminado o período sem renovação confirmada, a agência continua escrevendo por 3 dias, com o banner "Pagamento pendente: atualize o pagamento até dd/mm" (a data, no dia de São Paulo). Passados os 3 dias, entra no somente leitura, o mesmo do trial vencido, até a renovação ou uma nova assinatura; os dados ficam guardados. Uma renovação confirmada dentro da tolerância, e uma nova assinatura da mesma agência nessa janela, começam o novo período no fim do anterior e não no instante da confirmação, para a tolerância não dar dias grátis. Os tetos do plano valem na tolerância como valiam no período. A assinatura cancelada não tem tolerância: vai direto ao somente leitura no fim do período. No gateway simulado, um número de cartão de teste fixo é recusado, para testar a tolerância no dev.
9. **Cancelada, a assinatura não se altera** até o fim do período: nem plano, nem extra. Até o fim do período o Owner desfaz o cancelamento com um clique, sem cobrança agora, e a renovação segue normal; a descida que estava agendada não volta, porque o cancelamento a desfez. Só o Owner reativa, sob as mesmas travas do cancelamento. Depois do fim, a agência assina de novo, com o período e a cobrança cheia de uma primeira assinatura.
10. **Uma cobrança pendente por agência.** Subir ou assinar abre uma cobrança que o provedor tem 30 minutos para confirmar; um pedido novo, uma descida agendada, um cancelamento ou uma cortesia a invalidam. O valor confirmado precisa ser o valor que o Owner viu, e a confirmação repetida é inofensiva.
11. **Quem pode assinar**: a agência em trial (vigente ou vencido), e a agência `ativo` cuja assinatura terminou. A agência `isenta` e a `ativo` sem assinatura (concedida pela operação) não assinam: o plano delas é da operação.
12. **Cortesia.** A operação pode pôr uma agência num plano pago sem cobrança: ela tem o teto do plano, sem extras, sem fim de período e sem renovação, e só a operação a muda ou a tira.
13. **Limite dos extras**: até 10 000 clientes e 10 000 GB de extra por assinatura, para uma conta absurda não estourar número.
14. **Colaboradores não têm teto nos planos pagos**, e o limite diário de e-mails passa ao das demais agências (200), como a decisão de 2026-10-26 já previa para quem não está em trial.
15. **Só o Owner**: a permissão `assinatura.gerenciar` existe no catálogo sem preset e nenhum papel pode carregá-la, como `colaborador.atribuir_admin`. O Admin não assina.
16. **"Avançar para o fim do período"** só age numa assinatura do provedor simulado: o banco confere o provedor da própria assinatura.
17. **Os preços e tetos dos planos e o preço dos extras** são linhas de tabelas que só o dono do banco escreve. A aplicação lê e nunca grava.

**Consequência.** Estrutural, no molde da decisão de 2026-10-29. As leituras de borda acima são o que o código faz; uma delas que o dono queira diferente muda a função correspondente do banco e o teste dela. Pede revisão de segurança independente.

**Origem.** Derivadas pelo implementador (#771), escolhendo o caminho mais restritivo onde nada estava escrito. Os itens 8 e 9, como a primeira leitura (sem tolerância, sem desfazer o cancelamento) foi trocada pelo dono em 2026-10-29, ao validar. O item 2 acompanha o 8.

**Validação.** Validada pelo dono em 2026-10-29, com os itens 8 e 9 alterados por ele.
