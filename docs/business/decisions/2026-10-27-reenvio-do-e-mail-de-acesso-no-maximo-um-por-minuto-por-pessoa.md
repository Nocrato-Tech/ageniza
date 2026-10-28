# Reenviar o e-mail de acesso: no máximo um por minuto por pessoa

**Data.** 2026-10-27

**Contexto.** A decisão "acessos pendentes na aba Acessos podem ser reenviados e removidos" limita o reenvio só pelo limite diário de e-mails da agência. Sem outro freio, um duplo clique ou um laço manda vários e-mails para o mesmo endereço antes de o dia acabar, e o endereço de uma pessoa de fora é quem recebe.

**Decisão.** Proposta: **um reenvio de e-mail por pessoa a cada 60 segundos**. Reenviar o e-mail de um acesso cujo último reenvio, ou cuja adição, foi há menos de 60 segundos responde 429 `RESEND_TOO_SOON`, não grava nada e não gasta lugar no limite diário. O relógio é o do banco (o evento de auditoria `client_member.added`, `client_member.readded` ou `client_member.resent` mais recente daquele acesso). A conversão do convite antigo não tem esse freio: o convite deixa de existir na mesma transação, então não há segundo clique possível.

**Consequência.** Vale só para o reenvio do e-mail de quem ainda não entrou. A tela mostra "Aguarde um minuto para reenviar de novo." e o botão volta ao normal. Se o dono não validar, a regra sai do banco e da tela e o limite diário segue como único freio.

**Origem.** Proposta da implementação, ao registrar a decisão "acessos pendentes na aba Acessos podem ser reenviados e removidos" (limite extra por pessoa pedido pelo maestro).

**Validação.** Pendente de validação do dono.
