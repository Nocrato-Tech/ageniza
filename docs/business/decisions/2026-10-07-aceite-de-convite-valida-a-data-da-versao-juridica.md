# O aceite de convite valida a versão de Termos e Privacidade como data real, como o aceite por documento

**Data.** 2026-10-07

**Contexto.** `app_private.accept_legal_document` (#81) recusa uma versão que não é uma data real ou que está no futuro, porque uma versão futura faria a regra "nunca regride" suprimir toda versão verdadeira dali em diante. `app_private.accept_invitation`, que grava as mesmas versões ao criar a conta, só recusava vazio: `2026-02-30`, `v1` ou `9999-12-31` entravam em `legal_acceptances` (issue #296, achado da revisão do PR #318).

**Decisão.** Quando a chamada grava o aceite, `accept_invitation` exige as duas versões no formato `AAAA-MM-DD`, como data real e não posterior a hoje no fuso `America/Sao_Paulo`, com o código `A0031` do aceite por documento. O vazio continua com `A0003`, e a chamada que não grava aceite não olha as versões. O corpo da função é o de `20261007000300`; só a validação é nova.

**Consequência.** Para a API tudo que começa com `A` é "convite inválido", então uma versão mal configurada em `AUTH_TERMS_VERSION` ou `AUTH_PRIVACY_VERSION` passa a recusar o cadastro com a mesma resposta que o vazio já dava. Não muda tabela, coluna, policy, formato de resposta nem a autorização.

**Origem.** Issue #296, por decisão do maestro com a autonomia dada pelo dono do produto em 2026-10-07.

**Validação.** Pendente de validação do dono.
