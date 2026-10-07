# A lista de colaboradores ordena por nome dobrado, sem acento nem caixa, e não pelo collation do banco

**Data.** 2026-10-07

**Contexto.** A SPEC §6 e o aceite da #89 pedem a lista "ordenada por nome ascendente". `listCollaborators` ordenava por `member.name asc` cru, isto é, pela ordenação do banco: o collation do PostgreSQL decide acento e caixa, o banco de produção não fixa collation no repositório, e nenhum teste prendia o caso comum em português. A carteira de clientes (#291) já resolve o mesmo problema dobrando o texto na consulta (`foldTextSql`), e a auditoria (#355) mostrou que fixar `collate "C"` deixava os testes verdes.

**Decisão.** A lista de colaboradores ordena por `foldTextSql(member.name) collate "C"` ascendente — o texto dobrado comparado **byte a byte**, determinístico em qualquer banco — com desempate por `membership.id`. O dobre é o mesmo da lista de clientes (#291): `normalize(..., NFD)` decompõe o acento, o regexp remove as marcas combinantes e `lower()` cobre maiúsculas, sem `unaccent`. `Ágata`, `álvaro`, `Beatriz`, `Édson`, `eduardo`, `Ana Maria`, `Ana-Lúcia` e `Anaïs` saem na mesma ordem em qualquer banco; nomes que dobram para o mesmo texto (`Ana` e `ana`) ficam na ordem do id do vínculo. O helper saiu do service de clientes para `plugins/infra/sql-text.ts`, para os dois módulos usarem a mesma expressão; a carteira de clientes mantém a ordenação sem `collate "C"`, com a mesma dependência por resolver (issue própria).

**Consequência.** A ordem da lista passa a ser o texto dobrado comparado byte a byte: acento, caixa, espaço, hífen e dígito ordenam do mesmo jeito em qualquer banco, sem depender do collation do banco de produção (que não é fixado no repositório). Muda apenas a ordem de exibição em nomes com acento, maiúsculas ou várias palavras, inclusive entre páginas; busca (`q`) e filtros não mudam. Ordenar pelo nome cru, dobrar sem `collate "C"` ou comparar pela collation do banco reabre esta decisão.

**Origem.** Issue #355 (auditoria de fechamento de Colaboradores, épico #88), decidida pelo maestro. **Pendente de validação** pelo dono do produto.

