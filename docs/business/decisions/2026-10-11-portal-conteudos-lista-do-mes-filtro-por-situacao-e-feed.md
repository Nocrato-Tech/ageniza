# Portal Conteúdos: o mês como lista por dia, o filtro por situação e o feed do cliente

**Data.** 2026-10-11

**Contexto.** A SPEC (`specs/conteudo.md` §7, "Esboço — portal") e a issue #269 desenham a tela do dono do negócio no celular: "O que precisa de você" no topo, o mês com `‹ Outubro ›`, a alternância `[Calendário|Feed]`, o filtro por status e linhas como "12 ter Reels · Aprovado". Não dizem como um calendário cabe em 390 px, que períodos a tela lê, se o filtro vale também no feed, como o conteúdo publicado aparece (a API o entrega ao portal, mas o esboço lista só quatro situações), quantos itens o bloco do topo mostra, nem o que acontece com o endereço `/portal/:clienteId/calendario`, que o e-mail "conteúdos para aprovar" (#571) ainda usa.

**Decisão.**
1. **O "Calendário" do portal é a lista do mês agrupada por dia.** Cada dia traz o número e o dia da semana ("12 seg"), por extenso para quem não vê a grade, e os conteúdos dele na ordem da API (dia, hora, `id`); não há grade de sete colunas. O card tem a capa, o título e "Formato · Situação". O período é o mês civil exato, do dia 1 ao último, lido pela consulta por período (`from` e `to`); `‹` e `›` trocam de mês, e o mês fica no endereço (`data`), que sem ele cai no mês de hoje no dia de `America/Sao_Paulo`. Trocar de mês mostra o esqueleto, nunca o mês anterior sob o título novo.
2. **O filtro** oferece Todos, Aprovado, Aguardando aprovação, Em ajuste, Em produção e **Publicado**. Publicado entra além das quatro situações do esboço porque a API entrega o conteúdo publicado ao portal e a pessoa o vê na lista; sem opção própria ele só apareceria em Todos. Os nomes são os do cliente ("Aprovado", e não "Pronto para publicar" da agência). O filtro vale só para a lista: o feed é a prévia do perfil, e filtrá-lo a desmentiria. Ele fica no endereço (`situacao`) e uma situação que não existe vale como Todos.
3. **O feed do portal** é a grade de três colunas do mês, com o mesmo critério do feed da agência (imagem, carrossel e reels, do mais recente ao mais antigo, "Planejado" só depois de hoje) e com o recorte do portal: o conteúdo em produção não tem capa, e a casa mostra a forma do formato. Vazio, diz "Nenhum post do feed planejado para este mês", sem as nove casas pontilhadas da agência. A vista fica no endereço (`vista=feed`).
4. **"O que precisa de você"** mostra os seis conteúdos aguardando aprovação de data mais próxima, cada um com a capa, o título e o dia, e a contagem **da API** entre parênteses ("(8)"); com mais de seis, diz "Mostrando 6 de 8". Não depende do mês que a pessoa está vendo, e não existe quando nada espera.
5. **O endereço antigo continua valendo.** `/portal/:clienteId/calendario` redireciona para `/portal/:clienteId/conteudos`, trocando a entrada do histórico (voltar não cai no endereço velho) e levando a query. O e-mail do #571 não muda.
6. **O card é um link para o post em tela cheia** (`/portal/:clienteId/conteudos/:conteudoId`: legenda, mídias, Aprovar, Pedir ajuste, conversa, que são das #270 e #600). O título é o link e a caixa dele cobre o card inteiro; vale para o card da lista, inclusive o de um conteúdo em produção (cujo post é só título, data e formato), e para a casa do bloco "O que precisa de você". As casas do feed, que são a prévia do perfil, não são links.
7. **O tour do portal segue só com Início e Marca no MVP; Conteúdos fica fora dele.** A `specs/clientes.md` (§ do tour) previa que Calendário entrasse no tour "com o seu módulo"; com o item novo da barra, o tour poderia ganhar um passo, mas o dono pediu para não abrir feature nova agora. O item **Conteúdos** existe na barra e funciona, e o tour não aponta para ele. Quando o dono quiser o passo, é uma entrada a mais no tour (`portal-tour.tsx`) e uma linha na SPEC. Este item é próprio e tem a sua validação.

**Consequência.**
- O rótulo do filtro é "Filtro" e o estado vazio do filtro diz "Nenhum conteúdo nesta situação neste mês", como no esboço: a tela do cliente não usa a palavra "status" (o teste do portal que proíbe termos internos continua valendo e cobre o mês, o mês vazio e o filtro vazio).
- Quem decidir mostrar "Publicado" como "Aprovado" para o cliente, ou tirar a opção, muda uma linha do mapa de rótulos e uma do filtro.
- A rota do post é de outro PR (#600): sem ela, o link cai no "não encontrado" do portal, e os dois PRs entram na mesma janela.

**Origem.** Issue #269, decidido pelo implementador a partir do esboço da SPEC.

**Validação.** Pendente de validação do dono (inclusive o item 7, que o maestro decidiu a pedido do dono para não abrir feature nova).
