# Escrita na filha do cliente recusada pela política é relida: arquivado é 409, só cliente aberto é 403

**Data.** 2026-10-11

**Contexto.** A corrida entre uma escrita na filha de um cliente e o arquivamento desse cliente tem duas janelas. Com o arquivamento **em curso** (ainda sem commit), a escrita passa pela política no snapshot em que o cliente está ativo e espera o gatilho `AFTER INSERT`, que levanta `A0020`: a rota já responde 409 `CLIENT_ARCHIVED` (#392). Com o arquivamento **já confirmado** entre a leitura do cliente pela rota e o `INSERT`, a política do `INSERT` recusa com `42501`, e a rota respondia 403, como se o papel não tivesse a permissão (revisão da Coruja, aplicada às rotas de pasta e de mídia do #406).

**Decisão.**
1. Nas rotas de pasta e de envio de mídia do cliente, a rota lê o estado do cliente **depois** das travas (pasta pai e cota da agência), nunca antes.
2. Um `42501` do `INSERT` dessas rotas não vira 403 de imediato: o cliente é lido de novo numa transação nova (a anterior está abortada). Arquivado responde 409 `CLIENT_ARCHIVED`; ausente responde o 404 da rota; só o cliente ainda aberto é o 403.
3. Remover mídia não precisa disso: `remove_media_asset` toma o cliente em `for share` e responde `A0081` (409) nas duas janelas.
4. Deadlock e falha de serialização (`40P01`, `40001`) respondem 409 `TRY_AGAIN` nas três rotas; nenhum erro do banco que a rota conhece vira 500.

**Consequência.**
- Cada rota de filha do cliente que ainda for escrita precisa do teste das duas janelas: o do arquivamento em curso (trava do gatilho) e o do arquivamento confirmado antes do `INSERT` (tabela travada pela transação do arquivamento, que a solta junto com o commit).
- A segunda leitura só roda quando o banco já recusou, então não custa nada no caminho feliz.

**Origem.** Revisão do #406 (issue #253), a partir da lição da revisão da Coruja.

**Validação.** Pendente de validação do dono.
