# ESTRUTURAL: planos pagos, assinatura e gateway de pagamento simulado no dev

**Data.** 2026-10-29

**Contexto.** O trial (decisão de 2026-10-26) é o único limite por plano e o upgrade era um comando interno da operação, porque não havia cobrança. O dono decidiu desenhar os planos pagos, a assinatura e a cobrança, começando por um gateway simulado no ambiente de desenvolvimento. Preço e pagamento estavam fora de desenho (decisão de 2026-09-24).

**Decisão.** O dono decidiu:

1. **Planos.** Os preços são provisórios e ficam numa tabela no banco, não fixos no código.
   - Essencial: 10 clientes, 20 GB, R$ 97/mês.
   - Profissional: 30 clientes, 100 GB, R$ 197/mês.
   - Agência: 60 clientes, 300 GB, R$ 397/mês.

   Colaboradores ilimitados em todos os planos pagos. Acessos ao portal sem limite e grátis em todos. Clientes arquivados não contam, como no trial.
2. **Extras por unidade**, na quantidade que a pessoa escolher, somados ao teto do plano: cliente a R$ 6/mês cada, armazenamento a R$ 0,40/mês por GB. A tela mostra o total na hora (por exemplo, "R$ 197 + R$ 42 = R$ 239/mês").
3. **Mudanças.**
   - Subir de plano ou aumentar extra libera na hora, com cobrança proporcional aos dias que faltam do período.
   - Descer de plano ou diminuir extra vale só no período seguinte e nunca abaixo do uso atual: recusa clara se o novo teto ficar abaixo dos clientes ativos ou do armazenamento usado.
   - Cancelar mantém tudo até o fim do período contratado. Depois a agência entra no somente leitura que já existe (mesmas exceções, mesmo banner, com texto de renovar a assinatura).
4. **O trial continua igual**: 14 dias, 3 clientes, 3 colaboradores, 2 GB. Quando acaba, o caminho é assinar. Ao atingir um teto, aparece o mesmo aviso de hoje, com as opções de subir de plano ou comprar extra.
5. **Gateway atrás de uma interface** (porta de pagamento). Só existe o adaptador "simulado"; o Asaas ou outro entra depois sem mexer em plano, assinatura ou limite. O simulado:
   - tem uma tela de "cartão" que aceita qualquer número e aprova na hora;
   - nunca guarda número de cartão, nem os últimos dígitos, nem envia isso ao servidor como dado de cartão;
   - só liga com `PAYMENTS_PROVIDER=simulado` e ambiente que não seja produção. A API em produção recusa subir com ele, e há teste disso. O código do simulado não entra na imagem de produção, se o build permitir; se não permitir, o motivo é dito;
   - no dev, tem um controle "avançar para o fim do período", só do simulado, para testar renovação, descida e cancelamento sem esperar 30 dias.
6. **O plano e o teto mudam só pelo servidor**, a partir de uma confirmação do provedor de pagamento. O front nunca grava o plano. Assinatura e faturamento são capacidade não delegável (decisão de 2026-09-24): só o Owner assina, troca, compra extra e cancela.
7. **Limites no banco**, como os do trial: trava a agência e conta na mesma transação. O armazenamento usa `agency_storage_quotas`.

**Consequência.** Estrutural. Há tabelas novas (planos, preços dos extras, assinatura, cobranças), `agency_accepts_writes` passa a conhecer o fim do período da assinatura, o limite de clientes sai da constante do trial para o teto do plano com os extras, e a permissão de assinatura entra no catálogo sem preset, para só o Owner a ter. Substitui em parte a decisão de 2026-10-26 (o upgrade pela operação, item 5) e a de 2026-09-24 (preço e pagamento sem desenho). O destino dos valores de `agencies.plan` e do comando `set-plan` da operação é proposto à parte e não é decidido aqui. Pede revisão de segurança independente.

**Origem.** Pedido do dono do produto, 2026-10-29, trazido pelo maestro.

**Validação.** Validada pelo dono em 2026-10-29.
