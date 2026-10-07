# "Sem permissão" não é uma tela: a interface espelha o 404 do backend
**Data.** 2026-09-24

**Contexto.** `apps/api/src/modules/tenancy/guards.ts` devolve **404** indistintamente para agência inexistente, suspensa e inacessível — de propósito, para nunca revelar existência. Faltava dizer o que a interface faz com isso, antes que a primeira tela decidisse sozinha.

**Decisão.** Três convenções que toda tela herda:

- **Sem permissão não é uma tela.** O item não aparece no menu, e a URL digitada na mão cai no mesmo "não encontrado" de um recurso inexistente. Nunca um "você não tem acesso a isto", que confirmaria a existência do recurso.
- **Vazio** é declarado na SPEC de cada listagem: o texto e a **ação primária de saída** — o que a pessoa faz quando não há nada.
- **Erro** sempre oferece repetir a ação; nunca apenas informa.

**Consequência.** A interface não pode inventar uma tela de acesso negado sem reabrir esta decisão, porque isso transformaria o 404 deliberado do backend num oráculo de existência. Listagem sem texto de vazio e ação de saída declarados está incompleta na SPEC.

**Origem.** Decidido em sessão (sessão 0 de autorização e transversais).

