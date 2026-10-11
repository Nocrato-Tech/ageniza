# Grants por coluna, e tabela nova sem privilégio automático para o `ageniza_app`

**Data.** 2026-10-10

**Estrutural.** Sim: revoga privilégios de tabelas que já existem, entre módulos, e muda o privilégio padrão de toda tabela futura de `public` e `auth`. Não altera tabela, coluna nem policy, e não precisa de backfill: a aplicação já só usa o que continua concedido.

**Contexto.** Achado Baixa 3 da revisão de segurança do PR #369 (Coruja), irmão da #296, registrado na #372. A decisão do dono de 2026-10-10 (comentário na issue) aprovou a mudança como estrutural.

- Sete tabelas tinham `GRANT INSERT` de tabela inteira para `ageniza_app` e nenhuma policy de `INSERT`: `agencies`, `agency_memberships`, `agency_storage_quotas`, `client_memberships`, `permissions`, `role_permissions` e `roles` (a issue falava de cinco; o catálogo tem sete). Hoje a RLS forçada impede qualquer gravação, mas uma policy permissiva criada por engano liberaria todas as colunas de uma vez.
- `invitations` e `user_context_preferences` têm policy de `INSERT`, e tinham o `INSERT` (a segunda também o `UPDATE`) de tabela inteira.
- O privilégio padrão da fundação (`20260915000000_database_foundation.mjs`) dava `select, insert, update, delete` a `ageniza_app` em toda tabela nova de `public`, e o de `auth` fazia o mesmo. Uma tabela criada por uma migration posterior ficava aberta ao papel da aplicação até alguém lembrar de estreitá-la.

**Decisão.**

1. **Sem `INSERT` onde não há `INSERT` legítimo.** As sete tabelas perdem o `INSERT`. Ninguém insere nelas como `ageniza_app`: quem insere é o dono do esquema (o CLI de agência, que conecta por `MIGRATION_DATABASE_URL`, e as funções `security definer`, como `accept_invitation`). Continuam com `SELECT`.
2. **Por coluna onde há.** `invitations` aceita `INSERT` só nas oito colunas que as rotas escrevem (`agency_id`, `purpose`, `email`, `role_id`, `client_id`, `token_hash`, `expires_at`, `invited_by_user_id`); o `UPDATE` dela já era só `revoked_at`. `user_context_preferences` aceita `INSERT` em `user_id`, `context_type`, `agency_id`, `client_id`, `updated_at` e `UPDATE` em `context_type`, `agency_id`, `client_id`, `updated_at`: a pessoa nunca troca o `user_id` de uma preferência. O `DELETE` dela continua, porque é a preferência da própria pessoa, com policy de `DELETE` própria, e não uma entidade de negócio.
3. **Tabela nova nasce sem privilégio nenhum para o `ageniza_app`.** Os privilégios padrão sobre tabelas de `public` e de `auth` são revogados. A regra daqui em diante é a que a #407 já segue: a migration que cria a tabela declara, grant por grant, o que o papel da aplicação pode fazer, por coluna no `INSERT` e no `UPDATE`, e nunca `DELETE` em entidade de negócio. Ficam como estão o padrão das sequências, o do esquema `pgboss` (a biblioteca da fila cria tabelas lá em tempo de execução) e as tabelas já existentes de `auth` (a biblioteca de autenticação as escreve inteiras) e de `audit`.
4. **Um teste de catálogo fixa a regra.** Ele lê os grants vivos e reprova qualquer tabela de `public` com `INSERT`, `UPDATE` ou `TRUNCATE` de tabela inteira para `ageniza_app`, e qualquer `DELETE` fora de `user_context_preferences`; reprova também um privilégio padrão para ele em `public`, `auth` ou em todos os esquemas, e prova que o detector enxerga o grant amplo criando uma tabela de sonda dentro de uma transação que é desfeita.

**Lock de linha.** `UPDATE` por coluna mantém o `select ... for update/share`, que só pede `UPDATE` em alguma coluna. Procurado em API, worker e CLI: a única tabela que perde `UPDATE` de tabela inteira é `user_context_preferences`, que nenhum código trava; as travas em `agencies` (CLI de agência) rodam como dono do esquema; e a de `invitations` (rota de reenviar) segue com `UPDATE (revoked_at)`. Um teste confere que o papel da aplicação ainda trava `invitations` e `user_context_preferences`.

**Consequência.**

- Uma migration nova, `20261010000500_least_privilege_grants_and_default_privileges.mjs`, sem editar as anteriores.
- Uma migration futura que cria tabela e esquece os grants deixa a aplicação sem acesso (erro 42501, "permission denied"), em vez de com acesso a tudo: o erro aparece no primeiro teste de integração, que é onde se quer vê-lo. PR aberto que cria tabela e dependia do privilégio padrão precisa declarar os grants ao trazer o develop.
- Não muda nenhuma rota nem o formato de resposta.

**Origem.** Issue #372; achado Baixa 3 da revisão de segurança do PR #369 (Coruja); decisão do dono em 2026-10-10 (comentário na issue).

**Validação.** Validada pelo dono em 2026-10-10.
