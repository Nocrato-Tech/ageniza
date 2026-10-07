# A área da agência vive em `/agencia/:agenciaId/...` no navegador
**Data.** 2026-09-29

**Contexto.** A decisão de 2026-09-15 manda o contexto na rota e nunca na sessão, mas ela falava da API (`/agencies/:agencyId/...`). No navegador, as SPECs de colaboradores e clientes usavam `/colaboradores` e `/clientes/:clienteId` sem contexto, e depois do login a pessoa caía em `/app`, um stub. A casca da área da agência (#181) não podia começar sem essa forma definida.

**Decisão.** Toda tela da área da agência fica sob **`/agencia/:agenciaId/...`**, com as rotas em português (`/agencia/:agenciaId/colaboradores`, `/agencia/:agenciaId/clientes/:clienteId/<aba>`). É o espelho do `/portal/:clienteId` já decidido para o cliente. A página inicial da agência é `/agencia/:agenciaId`, e `/app` deixa de ser destino.

**Consequência.** Duas abas com duas agências funcionam lado a lado sem interferência, e o link de qualquer tela carrega o contexto. As seções 7 de `specs/colaboradores.md` e `specs/clientes.md` passam a ser lidas com esse prefixo, e a #181 corrige o texto delas no mesmo PR. Trocar a agência na URL troca o contexto inteiro, inclusive o cache.

**Origem.** Decidido pelo dono do produto em sessão, a partir da #181.

