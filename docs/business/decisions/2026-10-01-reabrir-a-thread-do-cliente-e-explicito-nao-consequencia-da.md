# Reabrir a thread do cliente é explícito, não consequência da ordem de `now()`

**Data.** 2026-10-01

**Contexto.** Achado 1 da revisão de segurança do PR #206 (#124). O `created_at` do comentário e o `resolved_at` da thread usam `now()`, que é o início da transação, não o commit. Um comentário do portal cuja transação começa antes de a agência resolver a thread e confirma depois fica com data anterior ao `resolved_at`; a definição derivada de `thread-state.ts` ("aberta = `resolved_at` anterior ao último comentário") então considera a thread resolvida, e a pergunta nova sai de "aguardando a agência". `thread-state.ts` é a definição única que a listagem (#125), o portal (#129) e as rotas de conversa (#128, #130) reusam.

**Decisão.** A reabertura é **explícita**: um `CONSTRAINT TRIGGER` `AFTER INSERT` em `client_thread_comments`, `DEFERRABLE INITIALLY DEFERRED`, limpa `resolved_at` e `resolved_by` da thread quando o comentário é do lado `client`. Por rodar no commit, vale a ordem de commit — o comentário que confirma depois de uma resolução reabre a thread, independente de quando cada transação começou. O trigger trava a linha da thread (`select … for update`) antes de ler, e a resolução é um `UPDATE` de `client_threads` que trava a mesma linha, então comentário e resolução serializam. É `security definer` porque a pessoa do portal não tem `cliente.operar`; é de escopo único — só limpa os dois carimbos da thread daquele comentário — e nenhum grant novo nem policy afrouxada. `thread-state.ts` não muda de forma.

**Consequência.** A definição derivada deixa de depender da ordem de `now()`; a corrida deixa de perder a pergunta do cliente. O trigger é aditivo e não toca nenhuma tabela, grant ou policy existente.

**Origem.** Issue #212, achado 1 da revisão de segurança do PR #206. Migration `20260930000300_thread_reopen_on_client_comment.mjs`.

