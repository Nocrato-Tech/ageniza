# Transições do conteúdo: piso de data em 2000-01-01, corpo estrito e o dia da publicação pelo relógio do banco

**Data.** 2026-10-11

**Contexto.** As revisões do PR #555 (#256) deixaram três baixas na API das transições do conteúdo, registradas na issue #563. `publishedOn` e `publishOn` aceitavam qualquer dia real do calendário, inclusive `0001-01-01`, que nenhuma publicação real tem. `submit`, `unpublish` e `cancel` ignoravam um corpo com campo extra em vez de recusá-lo, ao contrário de `approve-by-agency`, `publish` e `reschedule`, cujos corpos são `.strict()`. E o dia da publicação, quando o corpo não o traz, era calculado do relógio da API (`new Date()`) e só então convertido pelo banco, enquanto o gatilho que recusa uma publicação no futuro compara com o `now()` do banco: dois relógios para a mesma regra.

**Decisão.**
1. **Piso de data: `2000-01-01`.** `publishedOn` (publicar) e `publishOn` (criar, editar e reagendar) recusam um dia anterior com `400 VALIDATION_ERROR`; o próprio `2000-01-01` é aceito. É uma regra do contrato (`CONTENT_DAY_FLOOR` e `ContentDaySchema`, em `packages/contracts`), uma só para os quatro campos. A data de criação da agência foi descartada como piso: a agência entra na plataforma com clientes que já publicavam, e um piso por agência travaria o que ela quer registrar do passado. O ano 2000 é redondo, anterior a qualquer rede social e a qualquer cliente, e barra o erro de digitação sem decidir por ela.
2. **Corpo estrito.** `submit`, `unpublish` e `cancel` aceitam `{}` ou nenhum corpo, e qualquer campo é `400 VALIDATION_ERROR` sem chamar o banco. O corpo vazio é um schema `.strict()` (`ContentMoveRequestSchema`) declarado em cada rota, e o OpenAPI o documenta.
3. **O dia da publicação sem corpo vem do banco:** `app_private.sao_paulo_date(pg_catalog.now())`, o mesmo `now()` que o gatilho usa para recusar o dia futuro. O relógio injetável (`dependencies.now`) continua só para o teste fixar um instante e nunca é passado em produção.

**Consequência.**
- O piso é só da API: o banco não tem `CHECK` para ele (nenhuma migration), então uma escrita que não passe pela API ainda grava `0001-01-01`. Fechar isso no banco é uma migration e um backfill de nenhuma linha, e não está nesta entrega.
- A tela (`<input type="date">`) não ganha `min` aqui: é outro PR.
- Quem manda corpo com campo extra nas três rotas passa a receber `400`; nenhuma tela faz isso.
- Com o relógio do banco, a API deixa de depender da hora da máquina que a roda para o dia da publicação.

**Origem.** Issue #563, baixas da segurança (Garça) e sugestões de código (Lupa) nas revisões do PR #555.

**Validação.** Pendente de validação do dono.
