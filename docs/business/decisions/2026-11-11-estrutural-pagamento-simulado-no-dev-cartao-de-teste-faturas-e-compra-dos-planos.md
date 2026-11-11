# ESTRUTURAL: o pagamento fica todo simulado no dev, com cartão de teste salvo, faturas e uma tela de compra dos planos que vende o valor

**Data.** 2026-11-11

**Contexto.** O quadro do redesenho (r0) mostra, na Assinatura, o cartão "final 4242 · vence 08/2028" com "Trocar", a lista de faturas e uma tela de compra dos planos ("Confirmar e pagar"). Hoje o pagamento é simulado e deliberadamente sem dado de cartão: a decisão [`2026-10-29-estrutural-api-da-assinatura-e-gateway-simulado`](2026-10-29-estrutural-api-da-assinatura-e-gateway-simulado.md) (item 3) manda que a tela nunca envie "número, final, validade nem nome". O dono acha a tela de Assinatura "crua": ela diz o básico e não passa o que a pessoa ganha ao assinar.

**Decisão.**

1. **Tudo simulado, só no dev.** O cartão salvo, o checkout e o pagamento existem só onde o provedor simulado existe (`PAYMENTS_PROVIDER=simulado` fora da produção real, a regra de `runsAsProduction` do item 4 da decisão de 2026-10-29). Na produção real, não há cartão nem checkout até um provedor real (Asaas, #785) entrar.
2. **Cartão de teste.** A agência salva um cartão de **teste**: o navegador só aceita os números de teste do provedor simulado (um aprovado e um recusado) e **o número inteiro nunca sai do navegador**. A API guarda e devolve **só os quatro últimos dígitos, a validade e a marca "teste"** (um por agência, "Trocar" o substitui). Número, código de segurança e nome nunca são enviados nem guardados.
3. **Faturas.** "Ver faturas" lista as **cobranças** da agência (data, descrição, valor e estado: paga, recusada, aberta, expirada), a partir das cobranças que já existem, em qualquer ambiente. Não há PDF nem nota fiscal.
4. **Checkout.** Uma tela de compra por plano ("Confirmar e pagar") mostra o plano, o valor mensal, o que é cobrado agora (a cotação), o cartão de teste e o total. Pagar chama o pagamento simulado com o resultado `approved` ou `declined`. Recusa, falha e abandono não mudam o plano, como já é. **Extras só depois de assinar** (decisão [`2026-11-06-extras-so-depois-de-assinar`](2026-11-06-extras-so-depois-de-assinar.md)).
5. **A tela vende valor.** A tela de planos e a de compra passam o que a pessoa ganha ao assinar (skill `revenue-centric-design`): o que cada plano destrava, para quem é, um exemplo concreto de uso e a **recomendação decidida** (o Profissional continua "Recomendado"; o plano que não cabe aparece desativado com o motivo, "Não cabe: 18 clientes ativos"). O texto fala de benefício e nunca promete o que o produto não faz (nada de publicação automática ou envio por WhatsApp).
5. **A cobrança continua só do Owner.** Todas as rotas exigem `assinatura.gerenciar` (item 1 da decisão de 2026-10-29), o portal nunca vê cobrança ([`2026-11-06-portal-nao-expoe-a-cobranca-da-agencia`](2026-11-06-portal-nao-expoe-a-cobranca-da-agencia.md)) e o upgrade continua proporcional.

**Substitui.**

- O item 3 de [`2026-10-29-estrutural-api-da-assinatura-e-gateway-simulado`](2026-10-29-estrutural-api-da-assinatura-e-gateway-simulado.md) ("O cartão simulado não é dado de cartão"), **só** no que a tela passa a guardar os quatro últimos dígitos, a validade e a marca de teste. O corpo do pagamento (`{ outcome }`) e o resto do item continuam.
- A cláusula de [`2026-10-29-estrutural-planos-pagos-assinatura-e-gateway-simulado`](2026-10-29-estrutural-planos-pagos-assinatura-e-gateway-simulado.md) em que o provedor simulado "nunca guarda número de cartão, nem os últimos dígitos, nem envia isso ao servidor como dado de cartão": passam a ser guardados os quatro últimos dígitos, a validade e a marca de teste, e nada além disso. Que o simulado só rode fora da produção real, e que o plano e o teto só mudem no servidor, continuam valendo.

**Consequência.**

- **É estrutural:** tabela nova para o cartão de teste (agência, quatro dígitos, validade, marca; `UPDATE` só pela função, sem `DELETE` além da troca) com RLS pela agência e `assinatura.gerenciar`; leitura nova das cobranças; e o `quote` passa a devolver os dias que faltam e as linhas da soma. **Sem backfill.**
- **Risco: Alto** (pagamento). Pede revisão de segurança independente: nenhuma rota ou log recebe número de cartão; um número fora da lista de teste é recusado no navegador **e** a API recusa qualquer campo além dos quatro; a produção real não expõe o cartão nem o checkout; só o Owner; cobrança de outra agência é `404`. A prova do pacote de produção sem o código simulado (item 5 da decisão de 2026-10-29) continua.
- O fluxo mobile da agência descreve o cartão, as faturas e o checkout.

**Origem.** Resposta do dono do produto em 2026-11-11 (pagamento todo simulado em dev, cartão salvo de teste, faturas das cobranças e tela de compra que vende valor) e decisão do maestro sobre o que o cartão guarda (risco 1 do inventário).

**Validação.** Pendente de validação do dono.
