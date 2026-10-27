# ESTRUTURAL: a conta que ninguém confirmou some em 7 dias, e a conta assumida perde o nome

**Data.** 2026-10-27

**Contexto.** O cadastro público (decisão de 2026-10-26) cria a conta com `emailVerified = false` e com o nome e o e-mail que quem preencheu o formulário digitou, e esse pode ser um terceiro. Se ninguém confirma, a conta fica no banco para sempre guardando dado pessoal de quem talvez nunca soube dela (revisão de segurança do PR #722, achado 4, Baixa, LGPD). E quando o dono verdadeiro do e-mail assume a conta pela redefinição de senha (decisão de 2026-10-26, item 5), o nome que o terceiro escolheu continuava lá: a revisão mostrou `Nome do Atacante` na conta do dono. A alternativa de pedir o nome de novo na tela de redefinição mexeria na rota de autenticação e foi descartada; zerar o nome e deixar a pessoa preenchê-lo no primeiro acesso resolve sem tocar nela.

**Decisão.**

1. Uma conta que **nunca foi confirmada** é apagada **7 dias depois de criada**. Um job do worker roda todo dia às 04:10 (horário de Brasília) e a cada partida do worker.
2. Só é apagada a conta que cumpre **todas** estas condições: `emailVerified = false`; criada há mais de 7 dias; sem agência própria; sem vínculo de colaborador nem de cliente; sem convite enviado ou aceito; sem sessão ainda válida. Uma conta criada pelo aceite de um convite tem vínculo, e por isso nunca é apagada, mesmo sem ter confirmado o e-mail. Uma conta confirmada nunca é apagada por este job, por mais antiga que seja.
3. Com a conta vão as confirmações pendentes, os aceites de Termos e Privacidade (revogados ou não: o aceite de quem nunca confirmou não prova nada, e a conta não existe mais) e os demais registros que só dizem respeito a ela (credencial, tokens de redefinição, preferência de contexto).
4. A regra mora numa função do banco que recebe **o instante como parâmetro** (o job passa o `now()` do banco), para os testes não dependerem do relógio. Ela só atende o worker (nunca uma requisição), roda uma de cada vez e apaga em lotes.
5. A auditoria registra `account.unconfirmed_purged` com o id da conta apagada e nada mais: nunca o e-mail nem o nome.
6. A redefinição de senha que **assume uma conta não confirmada** passa a **zerar o nome** gravado (`auth."user".name` é `not null`, então "zerar" é a string vazia). Quem assumiu a conta digita o nome no primeiro acesso. Redefinir a senha de uma conta já confirmada não toca no nome.
7. A retenção fica registrada em [`docs/business/retencao-de-dados.md`](../retencao-de-dados.md).

**Consequência.** Estrutural: é o primeiro caso em que o produto **apaga** uma conta, e `auth."user"` é global. Não altera tabela nem policy: acrescenta funções em `app_private` e redefine `confirm_email_by_password_reset`. Não exige backfill, mas a primeira execução apaga as contas não confirmadas que já passaram de 7 dias. Quem se cadastra e confirma depois dos 7 dias precisa se cadastrar de novo (o link de confirmação vale 24 horas, então o link dessa conta já estava morto). O nome vazio aparece como vazio no menu de conta enquanto a pessoa não o preenche: hoje nenhuma tela pede o nome no primeiro acesso, e isso fica como ponto em aberto para a camada de rota e de tela. Pede revisão de segurança independente.

**Origem.** Issue #724, aberta pela revisão de segurança do PR #722. Os 7 dias e o escopo das contas apagadas foram propostos na issue; o nome vazio no lugar de pedir o nome na rota e a exclusão de toda conta com vínculo, sessão ou agência são regras de segurança derivadas pelo maestro.

**Validação.** Pendente de validação do dono.
