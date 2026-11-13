# ESTRUTURAL: a cobrança registra a recusa do pagamento, e uma cobrança recusada não é paga de novo

**Data.** 2026-11-12

**Contexto.** O item 3 de [`2026-11-11-estrutural-pagamento-simulado-no-dev-cartao-de-teste-faturas-e-compra-dos-planos`](2026-11-11-estrutural-pagamento-simulado-no-dev-cartao-de-teste-faturas-e-compra-dos-planos.md) manda "Ver faturas" mostrar o estado de cada cobrança: paga, recusada, aberta ou expirada. Hoje, quando o cartão de teste recusado volta `declined`, a API só responde `{ status: "declined" }` e a cobrança continua `pending`: nada na cobrança a distingue de uma aberta, e a mesma cobrança ainda pode ser paga de novo (é o que o teste da rota do pagamento simulado afirma). A fatura não teria como mostrar "recusada".

**Decisão.**

1. **A cobrança guarda o instante da recusa** (`declined_at`, vazio enquanto não foi recusada). Quem grava é uma única função do banco, que a API chama quando o pagamento simulado volta `declined`, como a pessoa que paga: só quem tem `assinatura.gerenciar` na agência (o Owner) recusa, e só uma cobrança da própria agência. Nenhuma rota, e nenhum papel da aplicação, escreve a coluna direto. A recusa fica na auditoria (a agência, quem pagou e a cobrança), sem dado de cartão.
2. **Uma cobrança recusada fica recusada.** Ela não é confirmada depois e não é recusada duas vezes, e uma cobrança já paga, expirada ou com o prazo vencido (30 minutos) também não é recusada. Paga e recusada nunca coexistem na mesma cobrança. Recusa continua sem mudar o plano nem o teto, como já é.
3. **Nova tentativa é outra cobrança.** A mesma cobrança não é paga de novo: quem quer tentar outra vez pede uma cobrança nova (a mesma rota que abre a cobrança de uma mudança) e paga essa. Abrir a nova expira a pendente da agência, inclusive a recusada, que continua "recusada" na lista (a recusa tem precedência sobre "expirada"); a regra de uma cobrança pendente por agência e a validade de 30 minutos não mudam.
4. **A fatura mostra "recusada"** para a cobrança que tem o instante da recusa, e continua mostrando paga, aberta e expirada como antes.
5. **Sem backfill.** As recusas anteriores a esta decisão não foram registradas e continuam aparecendo como "aberta" (enquanto valem) ou "expirada".
6. **Só onde o pagamento simulado existe.** A função existe no banco em qualquer ambiente, mas só a rota do pagamento simulado a chama (item 1 da decisão de 2026-11-11). Como a recusa de um provedor real vai ser registrada é assunto da decisão que trouxer esse provedor (Asaas, #785).

**Substitui.** Nenhuma decisão escrita. Muda o que a rota do pagamento simulado faz hoje, que deixa a cobrança recusada aberta para ser paga de novo: passa a exigir uma cobrança nova (item 3).

**Consequência.**

- **É estrutural:** altera `subscription_charges`, tabela que já existe (coluna `declined_at` e uma regra de que paga e recusada não coexistem), e a função que confirma a cobrança passa a recusar a recusada. **Migration** nova, **sem backfill**. A RLS não muda; a coluna entra na leitura que as outras colunas da fatura já têm, nunca em escrita.
- **Risco: Alto** (pagamento). Pede revisão de segurança independente: só o Owner da agência recusa, a coluna não é gravável pelo papel da aplicação, recusar e confirmar a mesma cobrança ao mesmo tempo deixa uma só vencer, e a auditoria não leva dado de cartão.
- A API chama a função ao receber `declined` e passa a pedir uma cobrança nova para tentar de novo, e o fluxo mobile da assinatura descreve o estado "recusada". As duas mudanças são do PR que traz a API.

**Origem.** Decisão do maestro na execução do #890, a partir do item 3 da decisão de 2026-11-11 (mínimo sensato para o MVP: a cobrança registra a recusa).

**Validação.** Pendente de validação do dono.
