# O visual segue o quadro r0: semana no domingo, capa no card, sem celular ao lado, uma primária por bloco, papel com cor e coroa, e mascote sério na falha

**Data.** 2026-11-11

**Contexto.** O dono pediu "exatamente tudo igual ao proposto no quadro" do redesenho (r0). Em sete pontos, o quadro contraria uma regra de apresentação que as decisões e o design system ainda registram. Nenhuma regra de negócio muda aqui: é apresentação, registrada antes de a tela ser refeita.

**Decisão.**

1. **A semana começa no domingo**, no calendário da agência, no portal e em qualquer semana desenhada (`startOfWeek`), **inclusive no seletor de data** (`DatePicker`, `docs/design-system.md` 13.2, que desenhava a semana começando na segunda). O mês continua desenhado em semanas inteiras.
2. **O card do calendário tem capa.** O card mostra a capa do post (miniatura, não o original), o ícone do formato, o título e a etiqueta de estado; sem capa, o ícone do formato. A legenda "O formato tinge o card; o estado fica na etiqueta" fica sob o calendário. A capa é a miniatura do arquivo (`thumbnailAssetId`, já presente na lista do período), carregada sob demanda, e nunca o original.
3. **Sem o celular ao lado do calendário.** O calendário ocupa a largura toda. O feed continua na vista **Feed** (mês, semana e feed) e, no perfil do cliente, não há mais o celular ao lado.
4. **Uma ação primária por bloco.** A regra "uma ação primária por tela" passa a ser **uma por bloco** (cabeçalho, cartão, painel): cada bloco tem no máximo uma ação em índigo cheio, e as demais são secundárias ou terciárias. O índigo cheio continua só nos quatro usos de `docs/design-system.md` 25.2, e dois blocos vizinhos não competem: o primário de um é o destino principal do bloco dele. "Três primárias lado a lado" (por exemplo, três cartões "Assinar") deixam de ser aceitas como exceção: o recomendado é o primário e os outros, secundários.
5. **O papel tem cor e a dona tem coroa.** O crachá da Equipe mostra o papel numa etiqueta **colorida por papel** e a dona da agência (Owner) com uma coroa e "Dona da agência". A cor do papel é só uma marca de identificação e **não diz de quem é a vez**: usa o conjunto dos blocos de cor suave e sempre vem com o nome do papel, nunca só a cor. O papel que não tem cor própria fica no cinza.
6. **Mascote sério na falha.** O estado de falha (`EmptyState` de `kind="failure"`) mostra o **mascote sério**, o texto, "Tentar de novo" e, quando houver contato, "Avisar o suporte" e o código ("Código 503 · 11 nov, 10h42"). Vale na agência **e no portal**. O primeiro uso e a boa notícia continuam como estão. É um ponto de ênfase do palco, e a falha de página inteira (`StatusPanel`) já usava o mascote sério.
7. **Rótulo do contexto no portal.** O portal mostra "Com a <agência>" **acima** do nome do cliente (no lugar de "por <agência>" abaixo) e o papel "Aprova os posts" no rodapé da navegação. O Início da agência não tem atalhos de módulo: a pessoa chega aos módulos pela navegação, e o botão do topo é "Novo conteúdo".
8. **Sobrelinha.** O cabeçalho de página pode ter uma **sobrelinha curta de contexto** acima do título (a data de hoje no Início, "Agência" na Equipe). É contexto, nunca rótulo decorativo nem numeração.

**Substitui.**

- O **item 1** de [`2026-10-11-conteudo-calendario-da-agencia-semana-na-segunda-e-prazo-em-dois-dias`](2026-10-11-conteudo-calendario-da-agencia-semana-na-segunda-e-prazo-em-dois-dias.md) (a semana começa na segunda), e a frase "segunda primeiro" do `DatePicker` em `docs/design-system.md` 13.2. Os itens 2 a 6 seguem valendo.
- Os **itens 3 e 4** de [`2026-11-04-calendario-editorial-tem-mes-semana-e-feed-card-sem-capa-e-celular-so-na-tela-larga`](2026-11-04-calendario-editorial-tem-mes-semana-e-feed-card-sem-capa-e-celular-so-na-tela-larga.md) (card sem capa e celular na tela larga) e, em [`2026-11-10-cartao-de-conteudo-enxuto-e-fechamento-seguro-de-formulario`](2026-11-10-cartao-de-conteudo-enxuto-e-fechamento-seguro-de-formulario.md), só o trecho "o cartão não tem capa" (que dependia do item 3). Também vale sobre [`2026-11-04-o-celular-do-calendario-mostra-o-feed-inteiro-do-cliente`](2026-11-04-o-celular-do-calendario-mostra-o-feed-inteiro-do-cliente.md), no que a decisão descreve o celular ao lado.
- O trecho "uma ação primária por tela" de `docs/design-system.md` (13.1, 23 e 25.4) e de [`2026-10-13-pauta-quem-tem-a-vez-decide-a-cor-e-as-quatro-excecoes`](2026-10-13-pauta-quem-tem-a-vez-decide-a-cor-e-as-quatro-excecoes.md) (item 3, a ação do crachá), e o uso "a ação primária da tela, uma só" de [`2026-10-14-o-realce-tem-quatro-usos-incluindo-o-cliente-selecionado`](2026-10-14-o-realce-tem-quatro-usos-incluindo-o-cliente-selecionado.md): vale "uma por bloco".
- O item 2 de [`2026-11-11-nova-linguagem-visual-clara-com-blocos-de-cor-suave`](2026-11-11-nova-linguagem-visual-clara-com-blocos-de-cor-suave.md), só no trecho "cada cor tem um sentido, nunca decoração": a cor **do papel** é identificação, não estado; a cor de estado continua com o sentido que a decisão deu. O item 4 daquela decisão (número de resumo só com a ação) continua.
- A pílula neutra de papel com `ShieldCheck` de `docs/design-system.md` (13.3, Equipe) e a linha "Papel visível para todos" de `specs/colaboradores.md` no que a etiqueta é neutra.
- O trecho "a falha nunca tem" mascote do portal (`apps/web/src/portal.tsx`) e a regra de que o mascote só aparece no primeiro uso, em [`2026-11-10-tres-tipos-de-estado-vazio`](2026-11-10-tres-tipos-de-estado-vazio.md) (item 3, a falha com ícone de alerta): a falha ganha o mascote sério.
- O item "Nenhum rótulo acima do título (eyebrow)" de `docs/design-system.md` 25.4, só para a sobrelinha de contexto do item 8.

**Consequência.**

- Só a tela muda: nenhuma rota, tabela ou permissão. A capa do card usa a miniatura que a lista já traz; se o custo de URLs assinadas pesar em tela cheia, a medição é do PR, não uma regra.
- `docs/design-system.md`, `specs/conteudo.md` (seção 7), `specs/colaboradores.md` e os fluxos mobile são atualizados na mesma mudança.

**Origem.** Pedido do dono do produto em 2026-11-11 e decisões do maestro sobre cada divergência do quadro (riscos 8, 9, 10, 13 e 17 do inventário).

**Validação.** Validada pelo dono em 2026-11-12.
