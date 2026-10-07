# O SQL do papel de runtime (ageniza_app) é confiável

**Data.** 2026-09-29

**Contexto.** A re-revisão de segurança do PR #159 (issue #94) mostrou que a autorização dentro do trigger `app_private.check_agency_membership_update`, que decide *se* roda por `current_user`, continua lendo o GUC `app.user_id` — forjável por `ageniza_app` no meio do `UPDATE`. Forjando o GUC para o `user_id` do Owner, um `account_manager` sem `colaborador.atribuir_admin` concede `admin`. O achado é pré-existente (reproduzido igualmente no commit `4120330`), exige SQL bruto emitido como o papel de runtime e não é alcançável pelas rotas atuais, que só escrevem em `agency_memberships` a partir da #97.

**Decisão.** Aceitar o modelo de confiança em que o SQL emitido pela aplicação como `ageniza_app` é confiável: a aplicação define `app.user_id` por transação via `SET LOCAL`, a partir da sessão autenticada, e todo SQL é parametrizado (Knex), de modo que o cliente não influencia o GUC. Em troca, o trigger deixa de alegar imunidade a "any GUC trick"; o que ele garante é que roda sob `ageniza_app` e que um GUC limpo não pula a verificação.

**Consequência.** O endurecimento real — um contexto de ator por transação não forjável pelo papel de runtime — fica na #166 e precisa landar antes da #97. Até lá, qualquer barreira que dependa de `app.user_id` apoia-se na confiança no papel de runtime, e isso vale para a autorização do produto como um todo, não só para este trigger.

**Origem.** Re-revisão de segurança do PR #159 (issue #94); decisão do dono do produto em 2026-09-29.

