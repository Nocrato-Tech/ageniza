# ESTRUTURAL: os campos do cliente entram como colunas em `clients`

**Data.** 2026-09-26

**Esta é uma mudança estrutural**, pelo primeiro critério de [structural-changes.md](../structural-changes.md): altera uma tabela que já existe. Registrada antes de qualquer implementação.

**Contexto.** O cadastro decidido nesta entrevista — empresa, contato do dono, @ do Instagram, foto —, a data de encerramento, o "quem alterou por último" e a unicidade de nome entre ativos não cabem nas duas colunas atuais de `clients`. A alternativa era uma tabela 1:1, `client_profiles`, para não tocar a tabela implantada.

**Decisão.** **Colunas novas em `clients`**, todas anuláveis, sem backfill, mais o **índice único parcial** de nome entre ativos, sem diferenciar maiúsculas. `clients` ganha também as policies de `INSERT` e `UPDATE`, que hoje não existem. O estudo de marca, as personas e as threads nascem em tabelas próprias.

**Consequência.** O cadastro **é** o cliente, e a tabela 1:1 obrigaria um join em toda leitura só para evitar um `alter table` que agora custa pouco: não há dado real em lugar nenhum, porque tudo é local até o deploy. A migration dispara o gate de CI, e esta entrada é o que o satisfaz. Como o portal lê a linha inteira de `clients`, vale a regra já decidida: nenhum campo interno da agência sobre o cliente mora aqui.

**Origem.** Decidido em sessão (entrevista do módulo de clientes).

**Implementação.** PR #162, migration `20260928000100_clients_module.mjs`.

