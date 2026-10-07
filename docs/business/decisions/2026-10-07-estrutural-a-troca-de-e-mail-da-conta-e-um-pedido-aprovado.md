# ESTRUTURAL: a troca de e-mail da conta é um pedido aprovado pela operação, não uma edição
**Data.** 2026-10-07

**Contexto.** `auth."user"` é global: a mesma conta pode estar em várias agências, e para o Owner o e-mail amarra a assinatura. Por isso a decisão de 2026-09-24 deixou a troca de e-mail fora do MVP, com gatilho: o primeiro colaborador ou cliente real pedir a troca. Issue #80.

**Decisão.** O dono decidiu que a pessoa **não troca o próprio e-mail**: ela pede.

1. No menu de conta, "Pedir troca de e-mail": a pessoa informa o e-mail novo e confirma a **senha atual**. Grava-se um pedido (um aberto por conta; um novo substitui o anterior) e o endereço **atual** é avisado: "pediram a troca do e-mail desta conta; se não foi você, troque a senha". Senha errada não cria pedido.
2. A **operação da plataforma**, não o Admin de uma agência, lista, aprova ou recusa por um comando do CLI (`cli:email-change`), o mesmo caminho por onde a agência nasce. Não há tela de administração no MVP.
3. Aprovado, um link de **uso único**, válido por 48 horas, vai ao e-mail **novo**. Ao confirmar, o e-mail troca, todas as sessões da conta e os links de redefinição de senha pendentes são encerrados, e o endereço **antigo** é avisado.
4. E-mail novo que já pertence a outra conta recebe a **mesma resposta** de qualquer outro pedido, para a rota não revelar quais e-mails têm conta. A operação vê a colisão ao listar e ao aprovar, e a aprovação é recusada; se o e-mail for tomado depois da aprovação, o link morre como qualquer link inválido.
5. Conta que é Owner de alguma agência: o pedido existe igual, mas aprovar exige a operação confirmar a titularidade fora do produto (`--ownership-confirmed`).
6. Convites pendentes endereçados ao e-mail antigo não mudam: convite é por e-mail, não por conta.
7. **Trocar a senha desfaz o pedido.** O aviso diz "se não foi você, troque a senha"; sem isso a remediação que o produto ensina não interrompia o fluxo (revisão de segurança do PR #325): quem tinha a senha e uma sessão pedia a troca para um endereço seu, a vítima redefinia a senha, e o pedido seguia aberto, aprovável e confirmável sem sessão nem senha, levando a conta. Duas barreiras: a redefinição de senha encerra os pedidos abertos da conta (`superseded`, sem link), e a aprovação e a confirmação recusam o pedido feito sob uma credencial que mudou depois (impressão SHA-256 do hash da senha gravada no pedido: a do hash que a rota verificou, não a da credencial na hora do insert, e a função recusa o pedido cujo hash verificado já não é o da conta, sob a trava da conta). A confirmação também recusa a conta que virou Owner depois da aprovação, sem titularidade confirmada.

**Mecanismo.** O `changeEmail` do Better Auth 1.7.5 foi avaliado e descartado: é autoatendimento, sem senha atual nem aprovação; o token é um JWT que pode ser reapresentado até vencer; não grava pedido; não encerra sessões. O token é próprio, no formato do convite (32 bytes aleatórios, só o hash no banco, uso único), numa tabela nova, `email_change_requests`, que a aplicação não lê nem escreve: só duas funções `security definer` de escopo único, `app_private.request_email_change` (a conta vem do ator da transação, nunca de argumento) e `app_private.confirm_email_change` (por hash do token; troca, encerra e fecha numa transação, com o pedido e a conta travados).

**Consequência.** Estrutural: tabela nova, duas rotas (`POST /me/email-change`, `POST /email-change/confirm`), três e-mails transacionais e um caminho de escrita sobre o e-mail em `auth."user"`. Sem backfill e sem alterar tabela que já existe. Limitações aceitas: recusar não avisa a pessoa (a operação fala com ela fora do produto); a operação descobre os pedidos por `list`, sem notificação; quem perdeu o acesso ao e-mail antigo e à senha continua sem caminho, porque recuperação de conta fica fora do MVP; o teto de pedidos (5 por hora e por conta) é em memória, como os demais limites de autenticação. Trocar o e-mail por edição direta, ou aprovar por tela, reabre esta decisão.

**Origem.** Issue #80, decisão do maestro com autonomia dada pelo dono do produto em 2026-10-07. **Pendente de validação pelo dono do produto.**

