# Agência entra por cadastro público, com teste grátis

**Data.** 2026-10-13

**Contexto.** A decisão de 2026-09-15 ("Entrada de agências apenas por comando interno", issue #32) partia de um produto para a nossa agência e parceiros. O produto passa a ser vendido para qualquer agência: ela chega pela landing page, que explica funcionalidades e planos, escolhe um plano e cria a conta sozinha. Depender da operação para cada agência nova não escala e derruba a conversão.

**Decisão.** Existe cadastro público de agência. Quem se cadastra vira Owner de uma agência nova, que começa no plano de entrada grátis ("Teste grátis"). O comando interno (`pnpm cli:agency`) **continua** existindo para a nossa agência, que é isenta, e para parceiros ou contratos fechados à mão; agência criada por ele não passa pelo teste grátis.

**Consequência.** Reabre e substitui a decisão de 2026-09-15 na parte "não existe cadastro público"; o resto dela (a CLI roda fora do RLS e nunca imprime o token) continua. A SPEC de auth ("Cadastro público não existe e não vai existir", `disableSignUp: true`) precisa ser revista neste módulo. O cadastro público abre a porta para abuso do teste grátis, que este módulo precisa tratar.

**Origem.** Entrevista do módulo entrada, 2026-10-13.

**Validação.** Validada pelo dono em 2026-10-13.
