# A pendência do convite é decidida no fim da espera pela trava, não no início da transação
**Data.** 2026-10-07

**Contexto.** A revisão de segurança do PR #298 (#165) mostrou que reenviar, cancelar e aceitar decidiam "pendente" com o relógio do início da transação: se outra transação segurava a linha e o convite vencia durante a espera, a decisão já estava tomada sobre uma versão que o destrave tornava velha — um cancelamento que esperou 3 s cancelava um convite já vencido pelo relógio de parede. Achado Baixa, registrado na #304; a semântica antiga não dava poder novo, mas as três superfícies decidiam antes de saber com que versão da linha estavam lidando.

**Decisão.** A pendência passa a ser decidida **depois** da trava, quando a versão final da linha já é conhecida:

- Nas rotas de reenvio e cancelamento, o `select … for update` só trava e lê os campos; a pendência vem de uma **segunda instrução** (`expires_at > statement_timestamp()`), que só começa quando a trava já foi obtida.
- Em `app_private.accept_invitation` (migration nova `20261007000300_invitation_pending_after_lock`), a validade usa `clock_timestamp()` no lugar de `now()`: dentro de uma única chamada de função, `statement_timestamp()` não avança durante a espera (verificado no banco), então `clock_timestamp()` é o relógio que representa "depois das duas travas" e mantém as três superfícies iguais na propriedade que importa — decidir sob a trava, sobre a versão que a operação vai usar.

**Consequência.** Um convite que vence enquanto a requisição espera uma trava que outra transação segura (a linha do convite ou o slot de convites equivalentes) passa a ser visto como vencido: reenvio e cancelamento respondem `409`, a aceitação responde `410`, e nada é escrito. Nenhuma tabela, coluna, policy ou grant muda; a migration substitui a função no lugar, sem backfill. O relógio do processo continua fora da decisão (o teste de #165 que adianta o `Date` da API segue valendo): a borda exata é do relógio do banco, no fim da espera.

**Origem.** Issue #304, achado 3 da revisão do PR #298. Decidido pelo maestro.

