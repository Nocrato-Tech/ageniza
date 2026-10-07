# Contexto de tenant explícito na rota, nunca na sessão

**Data.** 2026-09-15

**Contexto.** O padrão comum é guardar a "agência ativa" na sessão depois do login.

**Decisão.** O contexto vai na rota (`/agencies/:agencyId/...`) e é revalidado a cada requisição. A sessão não guarda contexto algum. O último contexto usado é salvo como **preferência de navegação** e nunca concede acesso.

**Consequência.** Remover um vínculo, arquivar um cliente ou suspender uma agência tem efeito na requisição seguinte, sem logout. A mesma pessoa pode operar duas agências em duas abas sem interferência. Em troca, toda rota de domínio precisa passar pelas guardas de tenant.

**Origem.** Issues #32 e #33.

