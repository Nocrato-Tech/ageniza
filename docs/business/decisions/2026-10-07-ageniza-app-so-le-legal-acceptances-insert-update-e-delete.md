# `ageniza_app` só lê `legal_acceptances`: insert, update e delete são revogados

**Data.** 2026-10-07

**Contexto.** A SPEC (§6, issue #81, item 3) diz que `ageniza_app` "continua sem INSERT direto" em `legal_acceptances`. A migration `20260919000000` concedia `select, insert, update, delete` à tabela inteira, e quem barrava a escrita era só a RLS forçada, sem policy de escrita: os testes esperavam `row-level security`, não `permission denied`. Texto e código discordavam, e uma camada só separava a prova de consentimento de uma escrita direta (achado da auditoria de fechamento do módulo, issue #343). A mutação "conceder INSERT" era sem efeito, mas conceder INSERT **e** criar uma policy abria a tabela.

**Decisão.** Opção (b): uma migration nova (`20261007000500`) revoga `insert`, `update` e `delete` de `ageniza_app` em `public.legal_acceptances`. A gravação legítima não muda: passa por `app_private.accept_invitation` (cadastro) e `app_private.accept_legal_document` (aceite por documento, #81), ambas `security definer`, que rodam como o dono do esquema e não dependem do grant. O `select` continua, atrás da policy `legal_acceptances_select`. É defesa em profundidade, no espírito da #296: dois mecanismos independentes (privilégio e RLS) dizem a mesma coisa. Os testes esperam `42501` com a mensagem `permission denied for table legal_acceptances` (distinta de `row-level security`), e um teste de catálogo afirma `has_table_privilege` e `has_any_column_privilege`. A opção (a), só corrigir o texto da SPEC, foi descartada porque deixaria a tabela dependente de uma única barreira.

**Consequência.** Mexe em grant de tabela que já existe, por isso o gate de CI trata a migration como estrutural e este registro vai junto; pelos cinco critérios não é estrutural: nenhuma tabela, coluna, policy, formato de resposta ou forma de autorização muda, e não há backfill. Nenhuma rota usava a escrita direta. Quem precisar um dia de outro caminho de escrita sobre a tabela cria uma função `security definer` de escopo único, como as duas existentes, e não devolve o grant.

**Origem.** Issue #343, decisão do maestro com autonomia dada pelo dono do produto em 2026-10-07. **Pendente de validação** pelo dono do produto.

