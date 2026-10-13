# Estado comercial da agência separado do acesso e da suspensão administrativa

**Data.** 2026-10-13

**Contexto.** Teste, pagamento, carência, cancelamento, isenção e suspensão precisam de uma matriz única, sem espalhar cada situação financeira pelas rotas. Hoje a agência tem só `active` ou `suspended`.

**Decisão.** Estados comerciais e transições:

| estado | acessa | entra | sai |
|---|---|---|---|
| Teste | sim | e-mail confirmado no cadastro | Paga, no primeiro pagamento confirmado; Suspensa (teste expirado), no 14º dia |
| Paga | sim | pagamento confirmado | Em atraso, quando o pagamento falha; Cancelando, quando o Owner cancela |
| Em atraso | sim, com aviso | pagamento falhou | Paga, quando paga; Suspensa (inadimplência), no 8º dia |
| Cancelando | sim, até a data | Owner cancela | Paga, se o Owner desfaz antes da data; Suspensa (cancelamento), no fim do período pago |
| Isenta | sim | só pela operação, expressamente | plano pago, pela operação |
| Suspensa (teste, inadimplência ou cancelamento) | não | prazos acima | Paga, pelo caminho do motivo: inadimplência, pagando a cobrança vigente; teste expirado ou cancelamento, por nova contratação (pagar cobrança antiga de assinatura cancelada não reativa); Excluída, em 90 dias |
| Excluída | — | 90 dias ou pedido da agência | final |

A suspensão administrativa (operação, ordem judicial, segurança) é uma restrição independente do estado comercial, com motivo, e prevalece sobre ele. O acesso existe só quando não há suspensão administrativa e o estado comercial permite. Retirar a suspensão administrativa não devolve o acesso se o estado comercial não permitir. Enquanto há suspensão administrativa, a contagem de 90 dias pausa. A elegibilidade é recalculada sempre que qualquer uma das duas muda.

"Pagamento confirmado" é só o evento do provedor recebido pelo backend e verificado (webhook autenticado e conferido contra o provedor). A volta do checkout e o que o navegador informa nunca mudam o estado.

Isenta dispensa plano e limites comerciais, mas não limites técnicos, de segurança nem de proteção contra abuso.

**Consequência.** Estrutural: altera a tabela de agências, que já existe, e a forma como o acesso de tenant é avaliado. O `active`/`suspended` de hoje passa a ser derivado dessas duas dimensões, ou substituído por elas; a forma fica para a SPEC.

**Origem.** Entrevista do módulo entrada, 2026-10-13.

**Validação.** Validada pelo dono em 2026-10-13.
