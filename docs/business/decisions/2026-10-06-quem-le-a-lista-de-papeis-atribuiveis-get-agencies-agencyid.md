# Quem lê a lista de papéis atribuíveis (`GET /agencies/:agencyId/roles`)
**Data.** 2026-10-06

**Contexto.** O convite de colaborador (#107), a troca de papel (#97) e a reativação (#98) recebem `roleId` (uuid), mas os papéis de sistema são semeados com `gen_random_uuid()` e nenhuma rota em develop devolvia papel com id. A SPEC de colaboradores (`specs/colaboradores.md` §7) já pressupõe a lista — "Admin só aparece na lista de papéis para o Owner" —, mas não diz **quem** pode ler a lista, nem o catálogo tem uma permissão própria para isso.

**Decisão.** A rota `GET /agencies/:agencyId/roles` é lida por quem tem `colaborador.convidar` **ou** `colaborador.alterar_papel` (as duas permissões dos fluxos que a lista alimenta), e pelo Owner, por posse. Sem nenhuma das duas, 403. O papel Admin só aparece na resposta para o Owner — a interface esconder é conveniência, e as barreiras de convite e de troca de papel continuam recusando quem montar a requisição na mão.

**Consequência.** A lista expõe `{ id, key, name }` dos papéis de sistema e dos papéis da própria agência, na mesma ordem determinística por `key`. É a única rota que entrega ids de papel ao front, e desbloqueia a #107; a #97 e a #98 passam a ter a mesma fonte. O `x-permission` desta rota passa a admitir uma lista (ou) no OpenAPI, e a avaliação de autorização ganha a forma "alguma das permissões" apenas aqui — as guardas existentes não mudam.

**Origem.** Issue #287, decidida pelo maestro a partir da lacuna achada na #107. **Pendente de validação** pelo dono do produto.

