# Conferir a sessão da aba não renova a sessão

**Data.** 2026-10-08

**Contexto.** A decisão de [encerrar as sessões na remoção](2026-10-08-remover-colaborador-ou-acesso-ao-portal-encerra-todas-as-sessoes.md) faz o web conferir a própria sessão a cada 45 s e ao voltar ao foco. O `GET /auth/session` chama `getSession` do Better Auth sem `disableRefresh`, e a sessão é renovada a cada 24 h de uso (`updateAge`, [decisão de 2026-10-07](2026-10-07-a-sessao-vale-7-dias-sem-uso-renova-a-cada-24-h-de-uso-e.md)). Uma aba esquecida aberta, conferindo sozinha, contaria como uso e a sessão nunca expiraria pelos 7 dias sem uso (até o teto absoluto de 30 dias).

**Decisão.**

1. **A conferência da aba não conta como uso.** Existe uma rota própria, `GET /auth/session/check`, que responde o mesmo que `GET /auth/session` (a pessoa e o `expiresAt`), mas lê a sessão com `disableRefresh`: `expiresAt` e `updatedAt` não mudam e nenhum cookie é emitido.
2. **Sessão revogada, apagada ou vencida responde 401**, como em qualquer rota autenticada, e o teto absoluto de 30 dias continua sendo imposto (a sessão mais velha que isso é revogada e recusada).
3. **`GET /auth/session` continua como era:** conta como uso e renova, porque é o que o web chama ao abrir e ao entrar. Só a conferência periódica usa a rota nova.

**Consequência.** Sem migration. Uma rota de leitura nova, documentada no catálogo e no `openapi.json`. O guard `requireSession` ganha uma opção (`renew: false`); as demais rotas não mudam. Quem consultar a rota nova não prolonga a própria sessão: se a aba ficar parada por 7 dias sem nenhuma ação da pessoa, a sessão expira.

**Origem.** Resposta do dono à pergunta do maestro sobre a revisão do PR #419 (`GET /auth/session` renova a sessão); issue #411.

**Validação.** Validada pelo dono em 2026-10-08.
