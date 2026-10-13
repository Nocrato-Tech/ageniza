# Cadastro pede o mínimo, e o teste começa na confirmação do e-mail

**Data.** 2026-10-13

**Contexto.** Cada campo a mais no cadastro derruba a conversão, e cadastro que nunca confirma o e-mail não deveria ocupar documento nem virar agência.

**Decisão.** O cadastro pede nome da pessoa, e-mail, senha, nome da agência, CPF de quem se cadastra, e o aceite de Termos e Privacidade. Não pede telefone, endereço nem segmento; o provedor de pagamento pede o que precisar na hora de pagar. Antes da confirmação do e-mail não existe agência; o teste de 14 dias começa quando o e-mail é confirmado.

**Consequência.** O cadastro pendente vale 7 dias, contados da criação. Confirmado no prazo, nasce a agência e começam os 14 dias. Depois de 7 dias sem confirmação, o backend apaga o cadastro pendente sozinho, e o e-mail e o CPF deixam de bloquear um cadastro novo, sem registro órfão e sem permitir duas criações simultâneas que furem a unicidade. Quem tenta confirmar um cadastro expirado é orientado a começar de novo.

**Origem.** Entrevista do módulo entrada, 2026-10-13.

**Validação.** Validada pelo dono em 2026-10-13.
