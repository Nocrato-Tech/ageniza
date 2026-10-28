# Entrada de agências apenas por comando interno

**Data.** 2026-09-15

**Contexto.** O produto atende a nossa agência e parceiros. Um cadastro público exigiria billing, trial e verificação de identidade, nada disso no escopo.

**Decisão.** Uma agência só nasce por comando interno da operação (`pnpm cli:agency`), que cria a agência e envia o convite de ativação. Não existe cadastro público nem cobrança dentro do sistema.

**Consequência.** Toda agência tem um responsável humano da operação. A CLI roda fora do RLS, com credencial de migração, e nunca imprime o token do convite — só o id e a expiração.

**Origem.** Issue #32. **Substituída em parte em 2026-10-26**, quanto à agência nascer só por comando: ela passa a nascer também pelo produto, em trial (ver a entrada de 2026-10-26 "ESTRUTURAL: a agência nasce pelo produto, em trial de 14 dias, e o upgrade é da operação"). O comando interno, a CLI fora do RLS e a regra de nunca imprimir o token continuam valendo. **Substituída em 2026-10-27**: a agência só nasce pelo produto e o comando interno de criar agência deixa de existir (ver a entrada de 2026-10-27 "ESTRUTURAL: a agência só nasce pelo produto, o plano `isenta` e o aviso do somente leitura"). A CLI fora do RLS, agora só para trocar o plano e operar agências existentes, e a regra de nunca imprimir o token continuam valendo.

