# Assinatura

Planos pagos da agência (issue #772, épico #770): a API que mostra os planos e os preços, cota uma mudança, pede a cobrança,
cancela e reativa, e o porto de pagamento por onde a confirmação do provedor chega ao banco. A regra, os preços e o estado vivem
no banco (`packages/database`, migrations `20261029000100` a `20261029000400`); este módulo é a porta HTTP e a ponte com o provedor.

Decisões: `docs/business/decisions/2026-10-29-estrutural-planos-pagos-assinatura-e-gateway-simulado.md`,
`...-regras-derivadas-dos-planos-pagos.md`, `...-cobranca-renovacao-cancelamento-e-tolerancia.md` e
`...-api-da-assinatura-e-gateway-simulado.md`.

## Rotas (`/agencies/:agencyId/subscription`)

Todas exigem a permissão `assinatura.gerenciar`, que **só o Owner tem, por posse**: nenhum papel pode carregá-la (o banco recusa,
`23514`) e o Admin recebe `403`. Cobrança não se delega.

| rota | o que faz |
|---|---|
| `GET /plans` | planos, preços e extras, lidos das tabelas |
| `GET /` | a assinatura da agência: plano, extras, período, cancelamento, tolerância, uso e provedor |
| `GET /invoices` | as cobranças da agência, 20 por página, com a data, a descrição (plano e extras, escrita no servidor), o valor e o estado: `declined`, `paid`, `open` ou `expired`. Em qualquer ambiente |
| `POST /quote` | o total e o efeito (assinar, subir, descer) de uma mudança, calculados no servidor, com as linhas da soma (`lines`) e, só numa subida, os dias do período que a cobrança proporcional usa (`daysLeft` de `periodDays`) |
| `POST /charges` | pede a mudança; sobe ou assina gera uma cobrança pendente, descer só agenda para o próximo período, e uma subida de valor zero (plano mais barato com teto maior) é aplicada na hora, sem cobrança e sem passar pelo provedor |
| `POST /cancel`, `POST /reactivate` | cancela (vale também na tolerância) e reativa (só até o fim do período) |
| `POST /simulated-period-advance` | **só dev**: leva o período ao fim, para testar renovação e tolerância |
| `POST /charges/:chargeId/simulated-payment` | **só dev**: o cartão simulado, `approved` ou `declined`; a recusa fica registrada na cobrança |
| `GET /test-card`, `PUT /test-card` | **só dev**: o cartão de teste da agência (`{ card }`, `null` sem cartão); `PUT` salva ou troca |

As quatro últimas só são registradas com `PAYMENTS_PROVIDER=simulado` **e** ambiente diferente de produção; fora disso a rota não existe
(`404`). O inventário de rotas do `api-docs` é o de um app de teste, que as registra; em produção elas não aparecem. As faturas existem
em qualquer ambiente.

## Quem muda o plano

Só a confirmação do provedor. O front nunca escreve plano nem teto: `POST /charges` apenas cria a cobrança, e o plano e a cota
mudam em `app_private.confirm_subscription_charge`, chamada sem pessoa ligada, depois de o provedor aprovar. A única exceção é a
subida de valor zero (um plano mais barato com teto maior): o provedor não cobra zero, então `request_subscription_change` a aplica
na hora, na mesma transação e sob as mesmas travas, sem cobrança e sem deixar nada pendente. Os totais, o pro rata
e as recusas (`A0111` abaixo dos clientes em uso, `A0117` abaixo do armazenamento em uso) são do banco.

## O cartão

Decisão 2026-11-11 (que substitui o item 3 da de 2026-10-29): o que se guarda de um cartão são **só os quatro últimos dígitos, a
validade e a marca `test`**, numa tabela só (`agency_test_cards`), um cartão por agência ("Trocar" o substitui). Número, código de
segurança e nome **nunca** chegam ao servidor:

- `PUT /test-card` valida o corpo pelo contrato estrito (`{ last4, expMonth, expYear, brand: "test" }`): qualquer outro campo é `400`,
  e a resposta de erro não repete o que veio. O banco grava pela função `save_agency_test_card` (que confere o Owner e audita sem os
  dígitos); `A0124` vira `400 TEST_CARD_INVALID` e `42501`, `403`.
- `GET /test-card` lê sob a RLS, depois do guard do Owner: quem não pode recebe `403`, nunca `card: null`.
- O corpo de `simulated-payment` continua `{ outcome }` e nada mais (`.strict()`). `declined` representa o cartão de teste recusado,
  para exercitar a tolerância de três dias.
- Nenhum log nem evento de auditoria leva o número; o teste `card-data-snapshot.test.ts` define o que não pode aparecer nas cobranças, na
  assinatura e na auditoria (a única ação com a palavra é `subscription.test_card_saved`, sem valores).

## A recusa (decisão 2026-11-12)

Quando o provedor simulado devolve `declined`, a cobrança registra a recusa (`declined_at`) por `app_private.decline_subscription_charge`,
**numa transação própria, como a pessoa**, separada da leitura da cobrança, de qualquer pedido e da confirmação: a função só toma a trava da
agência, e juntá-la a quem toma também a da cota inverteria a ordem. `A0125` (a cobrança não está aberta) vira `409 CHARGE_NOT_OPEN`.
Uma cobrança recusada fica recusada: a rota de pagar a recusa **antes** de chamar o provedor (`409 CHARGE_NOT_OPEN`), e tentar de novo é
`POST /charges`, que abre outra cobrança e expira a recusada, que continua "recusada" nas faturas. Falha do provedor e abandono não
registram recusa.

## Contratos de segurança (Coruja, #772)

- **Falha fechada**: sem `PAYMENTS_PROVIDER` não há provedor e as rotas simuladas não existem. A API em produção recusa subir com
  `simulado` (`packages/config`, teste em `server.test.ts`), e a imagem de produção sai sem o código simulado
  (`PAYMENTS_SIMULATED=exclude`, `apps/api/Dockerfile`).
- **A cobrança é da agência**: antes de chamar o provedor, a rota lê a cobrança numa transação com a pessoa ligada, onde a RLS só
  mostra a da agência do Owner. A de outra agência é `404`, e a cobrança vizinha continua pendente.
- **Uma transação por chamada**: cancelar, reativar e avançar só pegam o lock da agência; pedir, confirmar e renovar pegam também
  o da cota de mídia. Juntar duas dessas numa transação inverte a ordem dos locks. Cada chamada ao banco usa a própria transação
  (`asOwner`), e o teste conta as transações por chamada.
- **Entrada validada antes do banco**: extras de 0 a 10000 e `provider_ref` de até 200 **bytes**; fora disso `400`, nunca `500`.
- O provedor é chamado **fora** de qualquer transação, e a confirmação é a segunda transação, sem pessoa.

## O que ficou fora

A renovação automática, a rejeição de renovação e a parada dos e-mails da agência somente leitura são do worker (PR seguinte da #772).
O adaptador real (Asaas) não existe: o porto (`packages/payments`) tem uma interface e o adaptador `simulado`.
A tela (#773) vem em PR próprio.
