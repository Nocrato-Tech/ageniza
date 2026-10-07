# Remover mídia é por função e se recusa em conteúdo já enviado para aprovação

**Data.** 2026-10-07

**Contexto.** A regra 12 da SPEC diz que mídia usada em conteúdo aprovado ou publicado não pode ser removida da pasta. A #247 criou `media_assets.removed_at` **sem** grant de escrita, deixando a remoção para a migration que protege essa regra (#384, achado do PR #383). A SPEC não diz o que acontece com a mídia de um conteúdo **aguardando aprovação**, nem quem pode remover.

**Decisão.**
1. `removed_at` só muda por `app_private.remove_media_asset(mídia, pasta)`, `security definer`. Exige `conteudo.operar` **e** `conteudo.visualizar` (quem não vê a mídia não a remove) e responde "não encontrado" (`A0080`) a quem não tem as permissões, a mídia inexistente, de outro cliente ou agência, de outra pasta e a que não está confirmada. Cliente arquivado: `A0081`. Remover duas vezes não é erro e não muda a data.
2. A função **recusa** (`A0082`, 409) a mídia usada, como arquivo ou como capa, por conteúdo **aguardando aprovação, aprovado ou publicado**. Aguardando aprovação entra além da regra 12, pela leitura mais conservadora: o cliente está olhando o post e a aprovação não confere a mídia de novo, então a mídia que sai nessa janela viraria um post aprovado sem arquivo. Conteúdo em produção, em ajuste e cancelado deixam a mídia sair; o envio e a publicação já recusam mídia removida (`A0065`).
3. A função trava o cliente (compartilhado, em conflito com o arquivamento), a mídia e **todo conteúdo que a usa** antes de ler o estado deles. Quem vence a corrida com o envio ou com a aprovação faz o outro esperar e ler o resultado.
4. A policy de `SELECT` de `media_assets` **não** esconde a mídia removida: `contents_guard` (security invoker) lê `removed_at` da capa para recusá-la, e uma policy que escondesse a linha transformaria a recusa em "capa não encontrada, deixada à chave estrangeira". A listagem da pasta filtra `removed_at is null`, e o portal já não vê mídia removida (`portal_content_media`).

**Consequência.**
- A API (#253) traduz `A0080` em 404, `A0081` em 409 `CLIENT_ARCHIVED` e `A0082` em 409.
- **Limite conhecido:** uma capa trocada para a mídia no mesmo instante em que ela é removida pode deixar um conteúdo aguardando aprovação com capa removida, porque `contents_guard` lê a mídia sem travá-la. O envio e a publicação continuam recusando mídia removida, e o portal não a mostra; fechar de vez pede mexer em `contents_guard`, que é da #249.
- Não é estrutural: só funções novas e um índice em `contents (cover_asset_id)`.

**Origem.** Issue #384 e regra 12 da SPEC; o item "aguardando aprovação" foi decidido na implementação.

**Validação.** Pendente de validação do dono.
