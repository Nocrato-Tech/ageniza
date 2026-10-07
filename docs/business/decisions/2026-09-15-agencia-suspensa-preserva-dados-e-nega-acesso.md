# Agência suspensa preserva dados e nega acesso

**Data.** 2026-09-15

**Contexto.** Era preciso um estado para interromper uma agência sem destruir nada.

**Decisão.** Agência tem `active` ou `suspended`. Suspensa: o acesso àquele tenant é negado, os convites dela não podem ser aceitos, e os vínculos dela não valem como contexto. Nenhum dado é alterado, e os outros contextos da mesma pessoa seguem funcionando.

**Consequência.** Reativar devolve tudo. Fica o invariante para o futuro: jobs de agência suspensa não executam ação de negócio externa, como publicar conteúdo agendado.

**Origem.** Issue #32.

