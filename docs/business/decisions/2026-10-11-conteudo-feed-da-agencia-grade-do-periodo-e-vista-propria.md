# Conteúdo: o feed da agência é a grade do período na tela, e tem uma vista própria

**Data.** 2026-10-11

**Contexto.** A SPEC (`specs/conteudo.md` §7) diz que o feed é a "grade 3×3 dos conteúdos de feed não cancelados, sincronizada com o período; vídeo longo e VSL só no calendário", "do mais recente ao mais antigo, como no Instagram", com marca de planejado nos futuros e, na alternância Calendário | Feed | Pastas, o Feed como uma das vistas. Não diz o que "3×3" quer dizer com mais de nove posts, como se ordena quando o dia e a hora empatam, o que é "futuro", nem o que a aba Feed abre.

**Decisão.**
1. **Três colunas, sem limite de linhas.** A grade tem sempre 3 colunas e mostra todos os posts do período (a SPEC chama de 3×3 o desenho vazio, com nove casas). Mais de nove posts descem em novas linhas. Vazia, desenha as nove casas pontilhadas e diz "Planeje o primeiro post".
2. **O feed usa o período do calendário.** Não há consulta própria: a grade lê a mesma resposta da consulta por período, com o mesmo `from` e `to`. Mês e semana, a data e o cliente da URL valem para os dois, e navegar muda os dois juntos. O feed não guarda histórico além do período que está na tela.
3. **O que entra.** Imagem, carrossel e reels, em qualquer estado menos cancelado. Vídeo longo e VSL ficam só no calendário. Um período em que só há o que o feed deixa de fora é vazio para o feed.
4. **A ordem.** Do mais recente ao mais antigo por dia, depois por hora; um conteúdo sem hora conta como o fim do dia (a ordem do calendário lida de trás para a frente); e o empate de dia e hora vai para o `id` maior. A grade é sempre a ordem do calendário invertida.
5. **"Planejado"** é o conteúdo cujo dia é depois de hoje no dia de `America/Sao_Paulo`. Hoje não é planejado.
6. **A aba Feed** abre uma vista só do feed, no lugar do calendário, na mesma coluna e com a mesma navegação de período; nela o feed do lado direito some, para não haver duas grades. A vista vai na URL como `vista=feed`; o calendário é o padrão e não aparece na URL. Pastas segue fechada até a #267.
7. **A capa de cada casa** é a mesma do card do calendário: o endereço assinado do ativo de capa, lido só depois de a casa aparecer na tela e guardado por ativo; sem capa, ou quando a rota recusa, o formato aparece como forma.

**Consequência.**
- Um mês cheio mostra todos os posts do mês numa coluna lateral que rola; se um dia a agência quiser só os nove mais recentes, é cortar a lista numa linha.
- A prévia do feed que a #263 entrega serve ao portal na sua própria tela (outra issue), com o recorte do portal.
- Quem abrir a vista Pastas (#267) usa o mesmo parâmetro `vista`.

**Origem.** Issue #263, decidido pelo implementador a partir do esboço da SPEC e acordado com o maestro.

**Validação.** Pendente de validação do dono.
