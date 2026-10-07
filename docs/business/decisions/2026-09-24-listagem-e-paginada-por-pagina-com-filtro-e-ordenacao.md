# Listagem é paginada por página, com filtro e ordenação nomeados por rota

**Data.** 2026-09-24

**Contexto.** Nenhuma rota lista nada ainda, e `packages/contracts/src/pagination.ts` já contratava `{ data, meta }` com `page`, `pageSize`, `totalItems` e `totalPages` sem nunca ter sido usado. A primeira listagem define o padrão que todas as outras copiam.

**Decisão.** Paginação **por página**, com o contrato que já existe. Ordenação e filtro entram como **parâmetros nomeados por rota** — `sort=name:asc`, `status=active` —, declarados na SPEC do módulo. Não existe linguagem de consulta genérica na query string.

**Consequência.** O volume é de agência, e a contagem total é necessária para a interface; cursor fica fora até que alguma listagem prove precisar dele, e trocar depois muda o `meta` de toda rota já publicada. Parâmetro de filtro não declarado em SPEC não existe: isso é o que impede a query string virar API paralela.

**Origem.** Decidido em sessão (sessão 0 de autorização e transversais).

