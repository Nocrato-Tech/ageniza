# Regras invioláveis da entrada e da cobrança

**Data.** 2026-10-13

**Contexto.** As regras de entrada e cobrança são o contrato de comportamento do backend. Cada uma vira teste de integração que fica vermelho sem ela, com casos de sucesso, falha, repetição de evento e concorrência real (transações simultâneas, não sequenciais).

**Decisão.**
1. Nenhuma agência acessa sem um estado comercial que permita; a suspensão administrativa sempre bloqueia. Carência e isenção têm acesso explícito.
2. O estado comercial só muda por evento verificado do provedor, prazo aplicado pelo backend, ação autorizada do Owner ou comando operacional permitido. O navegador nunca define estado, pagamento confirmado ou isenção.
3. O mesmo evento do provedor, ou a mesma operação concluída, nunca produz efeito duplicado: cobrança, acesso, adicional ou transição.
4. Uma conta e um CPF abrem no máximo um teste grátis, de forma atômica sob cadastros simultâneos, sem gravar o CPF em claro.
5. Toda criação de cliente, convite ou upload confere o limite no servidor, no momento da operação; duas ações simultâneas nunca usam a mesma vaga. Até o Essencial o excesso é recusado; a partir do Profissional, só passa com o adicional comprado e ativo.
6. Retirar a suspensão administrativa recalcula o acesso pelo estado comercial e nunca o devolve se ele negar.
7. A suspensão administrativa não consome os 90 dias; coexistindo com uma comercial, a contagem pausa e retoma quando ela termina. A exclusão só acontece com o prazo vencido e os avisos enviados.
8. O CPF em claro nunca é gravado em banco, log, erro, telemetria ou auditoria; a duplicidade é conferida por HMAC com segredo fora do banco.
9. Só comando operacional autorizado, com motivo e auditoria, isenta ou tira a isenção; agência isenta nunca é cobrada.
10. O portal do cliente nunca expõe plano, situação comercial, cobrança ou adicional; só o Owner age sobre a assinatura; o Admin só lê.
11. A exclusão apaga o tenant inteiro (registros, mídia no armazenamento, convites, links), guarda só as exceções documentadas, é rastreável, repetível sem inconsistência, e só se dá por concluída depois de cada etapa verificada.
12. Trocar para um plano menor só é aceito se o uso couber, nunca arquiva, apaga ou esconde nada, e é conferido de novo quando passa a valer.
13. Evento de pagamento fora de ordem nunca desfaz uma transição mais recente: um aviso antigo de falha não suspende uma assinatura já paga.
14. Adicional só é comprado ou removido com confirmação do Owner, vendo o preço recorrente; entra inteiro na próxima fatura, sem proporcional; removido antes da renovação, não é cobrado no ciclo seguinte.
15. Ação operacional privilegiada (suspensão administrativa, isenção, exceção comercial, exclusão) exige autorização, motivo e auditoria; nenhum comando age só por estar disponível no terminal.

**Consequência.** Os prazos de retenção fiscal se validam com contabilidade ou assessoria jurídica; os 90 dias são política do produto, não regra legal. As regras fora do recorte do MVP ficam decididas e são implementadas quando a capacidade entrar.

**Origem.** Entrevista do módulo entrada, 2026-10-13.

**Validação.** Validada pelo dono em 2026-10-13.
