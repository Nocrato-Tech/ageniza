# Portal Conteúdos: card por formato com o estado na etiqueta, ícone do formato sem capa e vazios com saída

**Data.** 2026-10-15

**Contexto.** O redesign do portal na Pauta (decisão `2026-10-15-portal-na-pauta-tema-claro-sem-tokens-novos`, issue #688) pede para a lista de conteúdos o mesmo padrão dos cards do Calendário da agência, no claro. O item 1 de `2026-10-11-portal-conteudos-lista-do-mes-filtro-por-situacao-e-feed` e a SPEC (`specs/conteudo.md` §7) descrevem o card como capa, título e a linha de texto "Formato · Situação"; os vazios eram uma frase solta. A capa que não carrega mostrava os caracteres ▣ ▤ ▶ no lugar de um ícone, o que `docs/design-system.md` §25.4 proíbe, e o aceite adicional da revisão do #690 pediu ícones lucide.

**Decisão.**
1. **O card da lista do mês é o do Calendário da agência no claro.** Tingido pelo formato (carrossel em teal, reels em violeta, os demais neutros), traz a capa, o título (o link, cuja caixa cobre o card) e duas etiquetas: a do formato (`FormatTag`) e a da situação (`StatusTag`, com ícone e a palavra do cliente). Isto substitui a linha "Formato · Situação" do item 1 de `2026-10-11-portal-conteudos-lista-do-mes-filtro-por-situacao-e-feed`: as palavras são as mesmas ("Aprovado", "Aguardando aprovação"…), o dia continua no rótulo do grupo e o link, o filtro e a ordem não mudam. O estado nunca é só a cor do card: é a etiqueta.
2. **A capa ausente é o ícone lucide do formato**, em lugar dos caracteres: imagem `Image`, carrossel `GalleryVertical`, reels `Clapperboard`, vídeo longo `Video`, VSL `MonitorPlay`. O componente da capa é compartilhado, então a regra vale também para o calendário, o cartão flutuante, o feed e o modal da agência.
3. **Todo vazio diz o que falta e, quando há o que fazer, a saída.** Mês sem conteúdo: coruja amigável, "Nenhum conteúdo planejado para este mês" e "Quando a agência planejar, os posts aparecem aqui."; o botão "Ir para este mês" só existe quando o mês aberto não é o de hoje, porque no mês de hoje a pessoa do portal não tem como planejar nada. Filtro sem resultado: sem coruja (é uma busca sem resultado), a frase de antes e "Limpar o filtro". Feed sem post dos formatos do feed: sem coruja, a frase de antes, "O feed mostra imagens, carrosséis e reels. Os outros formatos estão na lista." e "Ver a lista". As frases que a SPEC e a decisão de 2026-10-11 fixam não mudam; entram só a descrição e os botões, que repetem controles que já existem na tela.
4. **A tela da lista não tem ação primária.** "Tentar de novo" do erro é secundário; o índigo cheio fica para a ação do post, que decide. O mês anterior e o próximo trocam os caracteres ‹ › por ícones `ChevronLeft` e `ChevronRight`.

**Consequência.** A SPEC §7 passa a dizer o card e o vazio do portal assim. Quem quiser a linha de texto de volta, ou o feed vazio sem a descrição, muda uma etiqueta e uma frase em `portal-contents.tsx`. A decisão de 2026-10-11 e a de `2026-10-15-portal-na-pauta-tema-claro-sem-tokens-novos` já estão registradas e não são editadas (AGENTS.md); esta é o item novo delas.

**Origem.** Issue #688, épico #685; aceite adicional da revisão da Garça no #690.

**Validação.** Pendente de validação do dono.
