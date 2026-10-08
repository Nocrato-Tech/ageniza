# O A0020 nas rotas que escrevem nas filhas do cliente: 409 para a agência, 404 para o portal

**Data.** 2026-10-07

**Contexto.** A migration `20261007001400` fez as dez tabelas filhas do cliente travarem o cliente (`FOR SHARE`) depois da `WITH CHECK` e levantarem `A0020` quando o arquivamento ganha a corrida. A decisão [`2026-10-07-arquivar-o-cliente-cancela-o-conteudo-e-trava-as-filhas.md`](2026-10-07-arquivar-o-cliente-cancela-o-conteudo-e-trava-as-filhas.md) (ponto 8) deixou a tradução para a API, e a issue #392 pede `409 CLIENT_ARCHIVED` em toda rota existente que insere nessas tabelas. Mapeadas as rotas, três pontos não estavam escritos.

**Decisão.**

1. **As rotas que inserem nas filhas** são quatro, todas em `clients`: `PUT .../brand-study/sections/:sectionKey` (insere a seção que ainda não existe), `POST .../personas`, e, nas duas portas (agência e portal), abrir conversa e comentar. Cada uma traduz o `A0020` por código (`databaseErrorCode`), não por `statusCode`, e nada é gravado: a transação é abortada pelo erro.
2. **A agência recebe `409 CLIENT_ARCHIVED`; o portal recebe `404 NOT_FOUND`.** Para a pessoa do portal o cliente arquivado é "não encontrado" em toda rota ([`specs/clientes.md`](../../../specs/clientes.md), seção das permissões e do portal), e a diagnóstica de recusa já respondia 404 ao portal no `42501` da mesma corrida. Um `409 CLIENT_ARCHIVED` ali contaria à pessoa do portal um estado que o resto do produto lhe esconde. O texto literal da #392 diz 409 para toda rota; vale a regra da SPEC para o portal, e a agência segue o texto.
3. **A mídia não muda.** `POST /agencies/:agencyId/media/uploads` só insere em `media_assets` com `agency_id` (biblioteca da agência, `client_id` nulo, que o gatilho deixa passar), e o worker só atualiza linhas existentes. Nenhuma rota de mídia alcança o `A0020` hoje; as rotas de pasta e de mídia por cliente nascem com as issues de Conteúdo (#253 em diante), que trazem o mapeamento.
4. **Editar o que já existe não é tradução de `A0020`.** O gatilho é `AFTER INSERT` (e `AFTER UPDATE OF publish_on` em `contents`, que ainda não tem rota). Persona editada ou arquivada e seção já preenchida não travam o cliente, por [decisão anterior](2026-10-07-arquivar-o-cliente-cancela-o-conteudo-e-trava-as-filhas.md) (ponto 5), então essas rotas seguem traduzindo só o `42501`.

**Consequência.**

- Sem migration e sem contrato novo: o `409 CLIENT_ARCHIVED` e o `404` já estavam nas respostas documentadas dessas rotas (`pnpm api:docs` não muda).
- Quem abrir a rota de Conteúdo, de pasta ou de roteiro copia o mapeamento de `clients/conversation-routes.ts`: `A0020` → `CLIENT_ARCHIVED` na agência, e não-encontrado no portal.
- Se o dono quiser o 409 também para o portal, é uma troca de uma linha em `conversation-routes.ts` e dos dois testes do portal.

**Origem.** Issue #392; PR #393 (gatilhos); revisão de segurança do #386 (padrão da corrida sequenciada por trava).

**Validação.** Pendente de validação do dono.
