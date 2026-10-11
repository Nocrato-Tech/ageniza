# O nome da agência recusa, na CLI, os caracteres invisíveis que a regra única recusa

**Data.** 2026-10-11

**Contexto.** A decisão de 2026-10-08 sobre os caracteres invisíveis ([`2026-10-08-invisiveis-recusados-no-nome-do-cliente`](./2026-10-08-invisiveis-recusados-no-nome-do-cliente.md), issue #427) fixou o nome do cliente e manteve, de propósito, o nome de pessoa, o cargo, a razão social e os contatos como estão: a regra de nome de exibição recusa só a categoria `Cf`. O nome da agência não está nessa lista. Ele entra só pela CLI de operação (`create --name`) e vai para os e-mails de convite e de ativação como texto, inclusive para o cliente, que lê o e-mail. Um seletor de variação solto (U+FE0F, U+E0100 a U+E01EF), o combinante U+034F, o braille em branco U+2800 e os demais caracteres que `hasInvisibleCharacters` recusa deixavam um nome de agência parecer outro (issue #576, revisão do PR #573).

**Decisão.** A CLI de operação recusa o nome da agência que `hasInvisibleCharacters` recusa (`packages/contracts/src/invisible-characters.ts`), além da regra de nome de exibição que já aplica. Uma sequência de emoji inteira continua aceita, como a regra a lê. Nada mais muda: o `createDisplayNameSchema`, o nome de pessoa, o cargo, a razão social e os contatos seguem como a decisão de 2026-10-08 os deixou. Essa decisão continua intacta e vale para tudo o que ela cobre.

**Consequência.** Um nome de agência com um desses caracteres sai da CLI com código diferente de zero e a razão em stderr, antes de qualquer escrita no banco ou envio de e-mail. Agências já criadas com esses caracteres não são corrigidas (sem backfill, sem migration).

**Origem.** Issue #576 (revisão do PR #578 da Garça), decisão do maestro de 2026-10-11 que restringiu a mudança à agência.

**Validação.** Pendente de validação do dono.
