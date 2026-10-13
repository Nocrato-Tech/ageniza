# Recorte do MVP da entrada e da cobrança

**Data.** 2026-10-13

**Contexto.** O produto ainda não foi lançado, e o MVP existe para validar se as agências pagam. As regras ficam decididas por inteiro, mas construir toda a cobrança antes de validar é custo sem retorno. Dinheiro e segurança são a exceção: errar ali dá prejuízo desde o primeiro cliente.

**Decisão.** Entra no MVP: cadastro, confirmação de e-mail e teste de 14 dias, com um teste por conta e CPF (HMAC); limites aplicados no backend, inclusive sob concorrência; checkout do Asaas e webhook verificado, idempotente e que não regride estado; fim do teste, 7 dias de carência e suspensão aplicados pelo backend; só o Owner paga e o Admin vê.

Fica decidido e fora do MVP: adicionais (no MVP todo plano recusa no limite, e quem precisa sobe de plano); troca para plano menor agendada para o próximo ciclo (no MVP, pelo suporte); exclusão automática em 90 dias (no MVP o sistema guarda a data e envia os avisos, e a exclusão é rodada pela operação por comando, com conferência); suspensões administrativas sobrepostas (basta a que existe).

**Consequência.** O recorte em issues gera só o que está dentro do MVP. Gatilhos: adicionais, quando a primeira agência estourar o plano Agência; troca agendada, quando o suporte receber pedidos de troca com frequência; exclusão automática, quando a exclusão manual passar a ser rotina.

**Origem.** Entrevista do módulo entrada, 2026-10-13.

**Validação.** Validada pelo dono em 2026-10-13.
