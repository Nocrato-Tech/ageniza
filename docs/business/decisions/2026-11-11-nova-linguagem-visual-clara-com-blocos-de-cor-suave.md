# O visual interno ganha uma linguagem clara de blocos de cor suave

**Data.** 2026-11-11

**Contexto.** O dono aprovou em 2026-11-11 o quadro do redesenho do visual interno (agência e portal), feito sobre a Pauta. A marca e as regras de uso do índigo não mudam; muda a hierarquia visual das telas, que precisava de mais calor e de leitura mais rápida do que o cinza sobre cinza.

**Decisão.**

1. **Paleta.** As três matizes da marca (índigo, violeta, teal) mantêm as âncoras e ganham degraus claros para fundo e etiqueta e escuros para o texto sobre eles; céu (agendado) e vermelho (atrasado) entram para dois estados. O canvas é um cinza com um sopro de índigo, e o cartão é branco.
2. **Blocos de cor suave.** Um resumo ou um destaque usa um bloco de fundo suave, e **cada cor tem um sentido**, nunca decoração: índigo é a vez da agência; violeta, aguardando o cliente; teal, aprovado; céu, agendado; vermelho, atrasado; cinza, neutro.
3. **Formas.** Cantos mais redondos (8, 12, 20 e 28 px; cápsula nas etiquetas), sombra suave só no que é alcançado ou flutua, e botão secundário em tom suave da marca.
4. **Número de resumo.** O número grande de um bloco só aparece com a ação que ele pede ao lado; o "número-herói" sem ação continua recusado.
5. **Acessibilidade mantida.** O contraste AA de cada par continua conferido por teste; o estado nunca é só cor, e quem pede menos movimento não recebe animação.
6. **Escopo.** A fundação (tokens, componentes de `packages/ui`, página `/design-system`) muda primeiro; as telas são refeitas depois, em escopos próprios, sem mudar o que cada uma faz.
7. **O que esta decisão substitui.** Estas decisões não são editadas; no que segue, vale esta:
   - [`2026-10-13-pauta-quem-tem-a-vez-decide-a-cor-e-as-quatro-excecoes`](2026-10-13-pauta-quem-tem-a-vez-decide-a-cor-e-as-quatro-excecoes.md), **item 1**, só no trecho "a cor fica no ícone e o rótulo em `text/secondary`": o estado passa a ser uma cápsula suave, com o fundo e o texto da família do estado e o ícone junto. Continuam valendo "quem tem a vez decide a cor", o atrasado em bloco cheio e "o estado nunca é só cor".
   - A mesma decisão, **item 2**, no trecho "degradê só na base do crachá do cliente": o crachá continua com o degradê dele, e entram dois degradês suaves, o do fundo do `EmptyState` (um toque do tom da família sobre a superfície) e o do disco do palco 3D. Continuam recusados o degradê em texto, em botão e em fundo de página, e o vidro, o glow e o blur decorativo.
   - [`2026-10-15-calendario-cards-por-formato-e-estado-na-etiqueta`](2026-10-15-calendario-cards-por-formato-e-estado-na-etiqueta.md), no trecho "o estado fica numa etiqueta com contorno": a etiqueta de estado é a cápsula suave da família (o publicado continua em superfície com fio).
   - [`2026-10-15-detalhe-do-cliente-na-pauta-sem-dados-que-a-api-nao-entrega`](2026-10-15-detalhe-do-cliente-na-pauta-sem-dados-que-a-api-nao-entrega.md), no trecho "sublinhado em tinta" das abas: a aba aberta é uma superfície branca com sombra suave sobre a trilha tingida, não um sublinhado.
   - A regra de `docs/design-system.md` "sombra só no que flutua" passa a ser "sombra suave só no que o dedo alcança (hover, aba e opção escolhidas) e no que flutua".

**Consequência.**

- O índigo cheio continua com os quatro usos da decisão de 2026-10-14 (ação primária, hoje, vez de quem olha, cliente selecionado).
- O app passa a ter um tema só (ver [`2026-11-11-agencia-passa-a-ser-clara-como-portal-e-entrada`](2026-11-11-agencia-passa-a-ser-clara-como-portal-e-entrada.md)).
- Nenhuma regra de negócio muda: é uma decisão de apresentação.

**Origem.** O dono do produto, ao aprovar o quadro do redesenho em 2026-11-11.

**Validação.** Pendente de validação do dono.
