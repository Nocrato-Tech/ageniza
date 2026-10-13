# Agência suspensa por falta de pagamento é apagada em 90 dias, com aviso

**Data.** 2026-10-13

**Contexto.** Quando o teste grátis acaba sem pagamento, a agência podia ser suspensa, ficar em modo leitura, ou ser suspensa e apagada depois de um prazo. Guardar para sempre a agência que nunca paga deixa o custo do armazenamento conosco.

**Decisão.** A agência é suspensa com o estado que já existe (decisão de 2026-09-15, "Agência suspensa preserva dados e nega acesso"): ninguém entra naquele tenant, os dados ficam guardados, os outros contextos da mesma pessoa seguem funcionando, e pagar reativa e devolve tudo. Se ficar 90 dias suspensa sem pagar, os dados da agência são apagados. Vale para o teste que acabou sem pagamento, para a assinatura que deixou de ser paga e para a assinatura cancelada depois do fim do período pago. O Owner é avisado por e-mail aos 60, 83 e 89 dias da suspensão, e a tela de entrada da agência mostra a data. A suspensão guarda o motivo e a data prevista de exclusão. Suspensão administrativa (pedida pela operação, por ordem judicial ou por segurança) não inicia a contagem. A agência pode voltar a pagar a qualquer momento antes da exclusão, e também pode pedir a exclusão quando quiser.

**Consequência.** Não existe modo leitura. Apagar a agência é um fluxo de retenção, a única porta para exclusão física que a decisão "Exclusão reversível" admite; ele precisa alcançar todas as tabelas do tenant e os arquivos do armazenamento.

**Origem.** Entrevista do módulo entrada, 2026-10-13.

**Validação.** Validada pelo dono em 2026-10-13.
