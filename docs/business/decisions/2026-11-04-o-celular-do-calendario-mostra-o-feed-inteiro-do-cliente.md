# O celular do calendário mostra o feed inteiro do cliente, de nove em nove

**Data.** 2026-11-04

**Contexto.** O celular ao lado do calendário mostrava o feed do período aberto, nove por página, com setas esquerda e direita, o contador "1–7 de 7" e os contadores do perfil contando só o período. Isso não parece um perfil real, e trocar de mês trocava o que o celular mostrava. A consulta por período tem teto de 93 dias e 500 itens e não pagina ([`2026-10-11-consulta-por-periodo-teto-de-500-itens-e-formato-da-resposta`](2026-10-11-consulta-por-periodo-teto-de-500-itens-e-formato-da-resposta.md)), então não serve para o feed inteiro.

**Decisão.**

1. O celular do calendário mostra o feed do cliente inteiro, independente do mês ou da semana abertos. Abre no post de data mais recente e vai para os mais antigos. Só image, carousel e reels; cancelados ficam de fora; a ordem é dia, hora (sem hora é o fim do dia) e id, do maior para o menor.
2. A tela do aparelho tem altura fixa e rola de verdade (roda, toque, teclado). Os próximos nove carregam ao chegar perto do fim. A grade tem três colunas e a última linha pode ficar incompleta, sem quadro vazio.
3. As setas passam a ser para cima e para baixo, movem uma tela (nove posts, três linhas) com rolagem suave e só ficam travadas no começo ou no fim reais do feed. Sem animação com `prefers-reduced-motion`. O contador "1–7 de 7" sai.
4. Os contadores do perfil (posts, prontos, aguardando) contam o feed inteiro e vêm da API.
5. A API ganha `GET /agencies/:agencyId/clients/:clientId/contents/feed?cursor=`, com a permissão `conteudo.visualizar` e o isolamento por agência e cliente da consulta por período, paginada por cursor de nove itens. Sem migration.
6. Criar, editar, mover de data e cancelar um conteúdo atualizam o feed.

**Não muda.** A aba Feed em tela cheia segue por período, trinta por página. O celular do link de aprovação e do portal fica como está. O calendário segue por período.

**Consequência.** Substitui, para o celular ao lado do calendário, a paginação "nove por página" com "1–9 de N" das decisões de 2026-10-16. Uma segunda leitura do mesmo conteúdo (o feed) existe agora ao lado da consulta por período; as duas devolvem o mesmo formato de item e quem muda um filtro do feed muda os dois lados (a leitura e a tela).

**Origem.** Pedido do dono no teste manual de 2026-11-04.

**Validação.** Pendente de validação do dono.
