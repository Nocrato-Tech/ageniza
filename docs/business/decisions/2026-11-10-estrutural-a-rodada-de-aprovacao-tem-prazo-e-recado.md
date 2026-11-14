# ESTRUTURAL: o envio para aprovação abre uma rodada, com prazo e recado opcionais

**Data.** 2026-11-10

**Contexto.** Hoje o envio para aprovação não leva prazo nem recado: o cliente recebe o conteúdo sem saber até quando decidir, e a agência não sabe há quanto tempo o conteúdo espera. O envio também é um conteúdo por vez, sem ideia de "o que foi enviado junto". A pesquisa de 2026-11-09 (Orkestrya e Refcat) mostrou que o prazo e o recado são o que faz o cliente agir.

**Decisão.**

1. **Prazo e recado.** Ao enviar conteúdos para aprovação, a agência pode dar um **prazo** e um **recado** ao cliente. Os dois são opcionais. O prazo vai de hoje até 90 dias à frente, no dia de São Paulo. O recado tem até 500 caracteres.
2. **Rodada.** Cada conteúdo enviado abre uma **rodada**, guardada numa **tabela nova**, uma linha por conteúdo enviado. Os conteúdos enviados juntos compartilham um **identificador de lote**. O lote é de **um cliente só**.
3. **Reenviar e retirar.** Reenviar o conteúdo depois do ajuste abre uma **rodada nova**. Quando o cliente retira a aprovação (decisão [`2026-11-06-cliente-pode-desfazer-aprovacao-antes-da-publicacao`](2026-11-06-cliente-pode-desfazer-aprovacao-antes-da-publicacao.md)), o conteúdo **volta à mesma rodada**, com o mesmo prazo e o mesmo recado.
4. **O que já aguardava.** O conteúdo que já aguardava aprovação antes desta mudança fica **sem data de envio e sem prazo**. Não há backfill.

**Consequência.**

- É estrutural porque o envio ganha uma forma nova (lote), o formato do conteúdo, do portal e do link de aprovação passa a trazer a rodada (data de envio, prazo e recado), e a regra de que o conteúdo antigo fica sem esses dados é deliberada: não se reescreve dado existente.
- Tabela nova (sem alterar tabela existente), com RLS por agência e por cliente, como as demais tabelas do conteúdo. O envio de vários conteúdos é tudo-ou-nada.
- O e-mail de envio passa a mostrar o prazo e o recado, assinados pela agência.
- O fluxo mobile da agência e o do portal (`docs/mobile/fluxos/`) descrevem a rodada.
- Pede revisão de segurança independente, por tocar o banco e a RLS.

**Origem.** Pedido do dono do produto em 2026-11-10, depois da pesquisa da Orkestrya e do Refcat (2026-11-09).

**Validação.** Validada pelo dono em 2026-11-12.
