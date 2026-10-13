# A operação age por comando interno auditado

**Data.** 2026-10-13

**Contexto.** A operação precisa suspender administrativamente, isentar, trocar o plano de um parceiro e consultar o estado comercial. Um painel interno é tela, permissão e superfície de ataque nova.

**Decisão.** No lançamento, essas ações são comandos internos, como o `pnpm cli:agency`, restritos ao ambiente operacional e nunca expostos ao frontend. Cada ação é auditada com operador, agência, comando, motivo, horário e resultado, sem segredo nem dado pessoal desnecessário. Ações críticas (isentar, suspender, excluir) exigem confirmação explícita e motivo.

**Consequência.** Em aberto, com gatilho: painel de operação, quando a operação precisar agir várias vezes por semana ou os erros manuais justificarem.

**Origem.** Entrevista do módulo entrada, 2026-10-13.

**Validação.** Validada pelo dono em 2026-10-13.
