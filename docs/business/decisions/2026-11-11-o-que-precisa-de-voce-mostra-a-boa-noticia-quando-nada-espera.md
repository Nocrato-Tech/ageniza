# "O que precisa de você" mostra a boa notícia quando nada espera

**Data.** 2026-11-11

**Contexto.** O item 4 da decisão [`2026-10-11-portal-conteudos-lista-do-mes-filtro-por-situacao-e-feed`](2026-10-11-portal-conteudos-lista-do-mes-filtro-por-situacao-e-feed.md) diz que o bloco "O que precisa de você", no topo de Conteúdos do portal, "não existe quando nada espera". Depois, a decisão [`2026-11-10-tres-tipos-de-estado-vazio`](2026-11-10-tres-tipos-de-estado-vazio.md) fixou que uma tela sem nada diz isso como boa notícia, e só quando a consulta respondeu. Com o bloco sumindo, o cliente não sabe se nada espera ou se a tela ainda não disse.

**Decisão.**
1. **Boa notícia no lugar do bloco ausente.** Quando a consulta do que espera aprovação respondeu e não há nenhum conteúdo esperando, "O que precisa de você" continua na tela e diz "Nada para aprovar", como boa notícia (ícone e texto).
2. **Falha não é boa notícia.** Se a consulta falhou, o bloco mostra a falha com "Tentar de novo", nunca "Nada para aprovar".
3. **O resto do item 4 continua.** Com conteúdos esperando, valem os seis mais próximos, a contagem da API entre parênteses e "Mostrando 6 de 8".

**Consequência.**
- Só a tela muda: nenhuma rota, tabela ou permissão.
- Esta decisão substitui só o item 4 de `2026-10-11-portal-conteudos-lista-do-mes-filtro-por-situacao-e-feed.md`, na frase "e não existe quando nada espera". Os demais itens dele seguem como estão.

**Origem.** O maestro, a partir da revisão da onda 5 do escopo telas-melhorias, aplicando a decisão de 2026-11-10 sobre os três tipos de estado vazio.

**Validação.** Pendente de validação do dono.
