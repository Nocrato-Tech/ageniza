# Design system

Como a identidade visual da Ageniza vira um sistema de UI consistente entre design e código. O objetivo é impedir que telas criem cor, espaçamento, tipografia e componente de forma independente.

**O repositório é a fonte de verdade — confirmado pelo dono do produto em 2026-09-28.** Até então este conteúdo vivia numa página do Notion, ["UI System — Figma, Design Tokens & CSS"](https://app.notion.com/p/3d886d2ba8b08172a3fbcc31e1548c31) (histórico — não usar como referência de trabalho); a página vira registro histórico, e a fonte passa a ser aqui, com uma página em `/design-system` no próprio app mostrando os tokens e componentes ao vivo (só no servidor de desenvolvimento; ver a seção 24 e a entrada de 2026-09-28 em `decisions.md`). Ver a entrada de 2026-09-28 "O repositório é a fonte do design system, com documento e página viva" em [`decisions.md`](business/decisions.md), que registra as decisões fechadas nesta data. O Notion permanece como registro histórico da decisão original, nunca mais como referência para implementar.

Logo, símbolo e mascote têm documento próprio: [Marca](brand.md).

**Tema único, claro (11/11/2026).** O app tem uma só linguagem visual, clara: agência, portal, entrada e páginas públicas usam os mesmos tokens, sem seletor de tema nem folha escura (decisões `2026-11-11-agencia-passa-a-ser-clara-como-portal-e-entrada` e `2026-11-11-nova-linguagem-visual-clara-com-blocos-de-cor-suave`). Tudo que este documento diz de "claro" e "escuro" antes dessa data foi reescrito; o escuro, se um dia voltar, é decisão nova.

Este documento migra o conteúdo da página original, adaptado aos caminhos e à stack reais deste repositório: React 19 + Vite, CSS puro com custom properties (sem Tailwind nem shadcn hoje — a seção 15 cobre a ponte para quando algum dos dois entrar).

## 1. Princípio central

O sistema segue três camadas de tokens:

```
Primitives
→ Semantic tokens
→ Component tokens
→ Components / Screens
```

**Regra:** telas e componentes não consomem HEX, pixels ou cores brutas diretamente quando existir um token equivalente.

Exemplo:

```
#4F46E5
→ color/indigo/600
→ action/primary/bg
→ Button / Primary
```

**Regra determinística de naming:** o nome CSS é `--` + o caminho trocando `/` por `-`.

```
action/primary/bg → --action-primary-bg
text/muted        → --text-muted
space/4           → --space-4
```

A mesma nomenclatura vale no Figma, quando ele existir, e no código.

## 2. Fonte de verdade

- **O repositório Git é a fonte de verdade dos tokens**, tanto do valor quanto do uso em runtime: `apps/web/src/styles/`.
- **Este documento** define princípios e tabelas de valor, e traz a proposta de Definition of Done (seção 23). As tabelas repetem os valores para leitura; **em divergência entre um valor citado aqui e o arquivo de CSS, vale o CSS**.
- **Figma** representa a aplicação visual dos tokens, componentes e telas, quando existir — hoje não existe nenhum arquivo Figma para este projeto. Ele entra no refino de cada tela (ver a entrada de 2026-09-28 sobre esboço → código → refino, em `decisions.md`), não antes.
- Nomes de tokens no Figma, quando existir, e no código devem permanecer equivalentes.

Quando o sistema amadurecer, os tokens podem ser centralizados em JSON compatível com Style Dictionary / Tokens Studio. Não é obrigatório automatizar isso agora.

> Se houver divergência entre um valor desenhado manualmente numa tela do Figma e um token oficial, o token oficial vence. A tela deve ser corrigida.

## 3. Estrutura recomendada do arquivo Figma

Vale a partir do momento em que existir um arquivo Figma para o projeto. Páginas previsíveis:

1. **00 — Cover & Guidelines**
2. **01 — Foundations** — logo e assinaturas aprovadas; cores primitives; cores semânticas; tipografia; grid; spacing; radius; shadows; iconografia; motion guidelines.
3. **02 — Components** — Button, Input, Select, Checkbox, Radio, Switch, Badge, Avatar, Tooltip, Dropdown, Tabs, Dialog, Drawer, Toast, Card, Table, Pagination, Empty State.
4. **03 — Patterns** — combinações recorrentes: Page Header, Filters Bar, Search + Filters, Form Section, Confirmation Flow, Content Card, Task Row, Client Card, App Shell, Sidebar.
5. **04 — Screens** — só telas reais do produto, compostas com componentes existentes sempre que possível.
6. **90 — Playground**
7. **99 — Archive**

## 4. Collections e modes no Figma

Vale a partir do momento em que existir um arquivo Figma. A estrutura descrita aqui é o vocabulário completo e aspiracional; o que o código implementa hoje é o subconjunto das seções 5 a 7, com valor real.

### Collection `Primitives`

Valores brutos, não mudam entre temas salvo exceção deliberada.

Para cores primitive, manter `scopes = []` é intencional: evita que valores brutos apareçam nos pickers de cor. Ao publicar como Library, marcar só as variáveis de cor como `hiddenFromPublishing = true`; spacing, radius, font e motion não se ocultam, porque são consumidos diretamente.

### Collection `Semantic`

Um mode só, `Light` (o app não tem tema escuro). Vocabulário completo (o código implementa o que tem valor real — seção 6):

```
bg/canvas
bg/surface
bg/elevated
bg/hover
text/primary
text/secondary
text/muted
border/default
border/subtle
action/primary/bg
action/primary/fg
action/primary/hover
action/danger/bg
action/danger/fg
action/danger/hover
action/disabled/bg
action/disabled/fg
focus/ring
status/success/fg
status/success/bg
status/success/border
status/warning/fg
status/warning/bg
status/warning/border
status/danger/fg
status/danger/bg
status/danger/border
status/info/fg
status/info/bg
status/info/border
```

Esses tokens apontam para `Primitives`. Não manter um único `status/success` etc.; Badge, Alert e Toast precisam de foreground, background e border independentes. **Nenhum `status/{success,warning,danger,info}` tem valor definido** — nem a página original dava um, só a direção ("success → green, warning → amber, danger → red, info → blue/cyan"); ficam pendentes até uma tela real precisar. O que o código tem hoje são os tokens de estado do conteúdo da Pauta, `status/{ready,waiting,adjust,late,published,production}/fg` (seções 6 e 25.1).

### Collection `Component`

Criar só quando houver necessidade real de uma decisão específica de componente. Exemplo:

```
button/primary/background
button/primary/background-hover
input/background
input/border
input/border-focus
```

Evitar token para cada detalhe de cada tela.

## 5. Paleta primitive

Implementada em [`apps/web/src/styles/tokens/primitives.css`](../apps/web/src/styles/tokens/primitives.css). Redesenhada em 11/11/2026 (decisão `2026-11-11-nova-linguagem-visual-clara-com-blocos-de-cor-suave`): as três matizes da marca (índigo, violeta, teal) mantêm as âncoras e ganham degraus claros (50, 100, 200), que viram fundo de bloco, de etiqueta e de hover, e escuros (700, 800), que carregam o texto sobre eles. Céu e vermelho existem para dois estados (agendado e atrasado). Nenhum HEX fora de `primitives.css`.

| Token | Valor | Uso conceitual |
|---|---|---|
| `color/ink/900` | `#111827` | texto forte; a faixa escura fixa do cabeçalho; a base do crachá do cliente |
| `color/ink/600` | `#4B5563` | só entra em `border/control` |
| `color/slate/700` | `#334155` | texto sobre `slate/100` (neutro) |
| `color/slate/600` | `#475569` | texto secundário; publicado |
| `color/slate/500` | `#617087` | texto muted; desativado; em produção |
| `color/slate/400` | `#A1AFC1` | só decorativo (ícone, divisória, ponto da trilha), nunca texto |
| `color/slate/300` | `#CBD5E1` | o @ sobre o crachá do cliente; a linha da trilha |
| `color/slate/100` | `#EEF1F6` | fundo do bloco e da etiqueta neutros |
| `color/mist/200` | `#E8ECF4` | bordas |
| `color/mist/100` | `#F4F6FA` | borda sutil; fundo de desativado |
| `color/cloud/100` | `#F3F4FA` | o canvas, com um sopro de índigo para o cartão branco aparecer |
| `color/white` | `#FFFFFF` | superfície de cartão |
| `color/indigo/50` | `#F1F2FD` | hover de linha e de item |
| `color/indigo/100` | `#E6E5FB` | bloco do índigo; ação secundária; trilha do `Segmented` |
| `color/indigo/200` | `#D0CEF7` | hover da ação secundária |
| `color/indigo/600` | `#4F46E5` | marca, ação principal, foco |
| `color/indigo/700` | `#4338CA` | hover da ação principal |
| `color/indigo/800` | `#3730A3` | texto sobre `indigo/100` |
| `color/violet/100` | `#EDE3FC` | bloco e etiqueta do violeta (aguardando o cliente) |
| `color/violet/600` | `#7C3AED` | identidade; ícone de aguardando |
| `color/violet/800` | `#5B21B6` | texto sobre `violet/100` |
| `color/teal/100` | `#D9F4F1` | bloco e etiqueta do teal (aprovado) |
| `color/teal/500` | `#14B8A6` | acento; o confete |
| `color/teal/700` | `#0F766E` | ícone de pronto; etiqueta de carrossel |
| `color/teal/800` | `#115E59` | texto sobre `teal/100` |
| `color/sky/100`, `600`, `800` | `#DDEFFA`, `#0369A1`, `#0B4F78` | agendado: bloco, ícone e texto |
| `color/red/100`, `700`, `800` | `#FBE4E1`, `#B42318`, `#8E1B12` | atrasado: bloco, ação de dano e texto |
| `color/orange/400`, `color/pink/500` | `#FF9A3C`, `#FF4F9A` | os dois tons quentes do confete |
| `color/stage/{indigo,violet,teal,sky,red}` e `-deep` | ver `primitives.css` | o tom do disco do palco 3D e a sua borda (seção 26); decorativos, fora da tabela de contraste |

### 5.1 Histórico

A migração do Notion (2026-09-28) aprovou nove valores que faltavam na página original e corrigiu quatro pares que reprovavam AA, só ajustando a luminosidade de `slate/500` (de `#64748B` para `#617087`) e criando primitives irmãos na mesma matiz; a Pauta (#621, 2026-10-13) acrescentou `violet/400` e `teal/700`. O redesenho de 11/11/2026 trocou a paleta pela da seção acima e tirou o que só o escuro usava (`ink/800`, `ink/700`, `indigo/550`, `indigo/400`, `violet/400`, `red/400`, `slate/300` como texto e `cloud/50`). Os valores antigos estão em `docs/business/decisions/2026-09-28-*` e `2026-10-13-*`, que não mudam.

## 6. Semantic tokens

Implementados em [`apps/web/src/styles/tokens/semantic.css`](../apps/web/src/styles/tokens/semantic.css), num único `:root`: é o tema do app inteiro.

| Token | Aponta para |
|---|---|
| `bg/canvas` | `color/cloud/100` |
| `bg/surface` | `color/white` |
| `bg/elevated` | `color/white` |
| `bg/hover` | `color/indigo/50` |
| `bg/tint` | `color/indigo/100` (trilha do `Segmented`; fundo de uma área de realce suave) |
| `text/primary` | `color/ink/900` |
| `text/secondary` | `color/slate/600` |
| `text/muted` | `color/slate/500` |
| `text/link` | `color/indigo/600` |
| `text/danger` | `color/red/700` (mensagem de erro de campo) |
| `border/default` | `color/mist/200` (decorativa; o limite de um controle é `border/control`) |
| `border/subtle` | `color/mist/100` (divisória de baixa ênfase) |
| `border/control` | `color-mix(slate/400 40%, ink/600)` = `#6D7989` |
| `action/primary/bg`, `fg`, `hover` | `color/indigo/600`, `color/white`, `color/indigo/700` |
| `action/secondary/bg`, `fg`, `hover` | `color/indigo/100`, `color/indigo/800`, `color/indigo/200` |
| `action/danger/bg`, `fg` | `color/red/700`, `color/white` (o hover do dano ainda é `filter: brightness(0.94)`) |
| `action/disabled/bg`, `fg` | `color/mist/100`, `color/slate/500` |
| `focus/ring` | `color/indigo/600` |
| `focus/halo` | `color-mix(indigo/600 22%, transparent)` (o halo de 4 px do campo em foco) |

**Estado, formato, bloco e crachá.** `status/{production,adjust,waiting,ready,scheduled,late}/fg` é a cor do ícone solto do estado (não-texto, 3:1); `status/*/bg` e `status/*/text` formam a cápsula suave do `StatusTag` (o atrasado é `action/danger` cheio). `status/published/fg` é o texto do publicado, que fica em superfície com fio. `calendar/today/bg` é `color-mix(action/primary/bg 14%, bg/surface)`. `format/{carousel,reels,static}/{bg,fg,tag/bg,tag/fg}` tinge o card do calendário por formato e preenche a etiqueta; o índigo fica fora dos formatos porque é da ação e do hoje. `block/{indigo,violet,teal,sky,red,slate}/{bg,fg}` são os blocos de cor suave dos resumos (seção 26): cada cor carrega um sentido (índigo, a vez da agência; violeta, aguardando o cliente; teal, aprovado; céu, agendado; vermelho, atrasado; cinza, neutro). `stage/*` são os tons e as medidas do palco 3D (seção 26) e `celebration/{gold,coral}`, os tons quentes do confete (seção 27). `client-badge/fade/{start,end}` é a base do crachá do cliente (índigo/600 e violeta/600 a 60% sobre `ink/900`), o degradê forte da interface; os degradês suaves do fundo do `EmptyState` e do disco do palco 3D são as outras exceções (seção 25.3). As regras de uso destas cores estão nas seções 25 a 27.

`text/muted` está apto para captions, metadata e helper text sobre `bg/canvas`, `bg/surface` e `bg/hover` (seção 20.1). Conteúdo desativado usa `action/disabled/fg`, não `text/muted`.

**Onde o contraste é garantido.** `text/link`, `text/danger`, `text/muted` e `border/control` valem sobre `bg/canvas`, `bg/surface` e `bg/hover`; sobre um bloco de cor e sobre `bg/tint`, o texto é `text/primary` ou o `-fg` do próprio bloco (20.1).

## 7. Tema único

Não há tema escuro nem seletor de tema. O app não escreve `data-theme` em `<html>` (a `DarkArea` e `area-theme.tsx` saíram), o `index.html` não traz o script que escolhia o tema, `themes/dark.css` e `themes/light.css` foram apagados e nenhuma regra usa `[data-theme]`. A agência é clara como o portal e a entrada (decisão `2026-11-11-agencia-passa-a-ser-clara-como-portal-e-entrada`, que substitui a de 2026-10-14, "agência sempre escura"). O que continua escuro por desenho: o cabeçalho fixo de `.app-shell` (seção 17), a base do crachá do cliente (seção 25.3), a moldura do celular do feed e o disco do palco 3D, que é um tom da família do cartão.

## 8. Spacing

Implementado em [`apps/web/src/styles/tokens/primitives.css`](../apps/web/src/styles/tokens/primitives.css). Escala de 4px:

| Token | Valor |
|---|---|
| `space/1` | 4px |
| `space/2` | 8px |
| `space/3` | 12px |
| `space/4` | 16px |
| `space/5` | 20px |
| `space/6` | 24px |
| `space/8` | 32px |
| `space/12` | 48px |
| `space/16` | 64px |

Evitar valores arbitrários como 13px, 19px ou 27px sem justificativa.

## 9. Radius

Implementado em [`apps/web/src/styles/tokens/primitives.css`](../apps/web/src/styles/tokens/primitives.css).

```
radius/sm   = 8px   (0.5rem)
radius/md   = 12px  (0.75rem)
radius/lg   = 20px  (1.25rem)
radius/xl   = 28px  (1.75rem)
radius/full = 9999px
```

Uso: `sm` botão pequeno, item de menu e controle de filtro; `md` botão, campo e item da navegação; `lg` card interno e cartão flutuante; `xl` diálogo, painel de tela e bloco de resumo; `full` avatar (e seu esqueleto), pílula (`Pill`, `PillAction`), etiquetas de estado e de formato, `Segmented` e indicador de carregando. O CSS ainda usa `full` em selos e marcas de telas não refeitas (`.clients__badge`, `.client-detail__status`, `.conversation__status`, `.portal-post__status`, `.content-card__badge`, `.content-folder__badge`, `.content-day__script`, `.content-feed__planned`, `.ui-choice-card__badge`) e na amostra de cor (`.brand-colors__swatch`, o hex é dado da agência); cada uma muda quando a tela for refeita. O `Realce` é a única forma fora da escala: seus cantos desiguais imitam a caneta marca-texto (seção 25.2).

## 10. Tipografia

Implementada em [`apps/web/src/styles/tokens/typography.css`](../apps/web/src/styles/tokens/typography.css) e [`fonts.css`](../apps/web/src/styles/tokens/fonts.css). **Archivo** (largura expandida) nos títulos e **Geist** em toda a interface, ambas servidas pelo próprio app, pelos pacotes `@fontsource-variable/archivo` (eixo `wdth`) e `@fontsource-variable/geist` (`globals.css` e `fonts.css`). Nenhuma requisição vai a uma CDN de fontes, então o IP de quem visita não chega a terceiro. Sora e Inter saíram.

```
font/brand → Archivo Expanded (wdth 118) · Archivo Semi Expanded (wdth 112)
font/ui    → Geist
```

O shorthand `font` não carrega largura e reseta `font-stretch`; por isso cada largura é uma família (`fonts.css`) sobre os mesmos arquivos variáveis.

Escala, cada degrau como uma custom property com o shorthand `font` (peso tamanho/entrelinha família):

| Token | Definição | Peso | Quando usar |
|---|---|---|---|
| `display/lg` | Archivo Expanded 48/52 | 800 | Abertura de página de marca ou de entrada. Nenhuma tela de trabalho o usa hoje. |
| `heading/xl` | Archivo Expanded 32/38 | 800 | O título da tela (o `h1`) e o do estado vazio com mascote. |
| `heading/lg` | Archivo Semi Expanded 22/28 | 700 | Título de painel, de seção e de modal; o do estado vazio sem mascote. |
| `title/md` | Geist 16/24 | 600 | Título de card e de item de lista. |
| `body/md` | Geist 14/21 | 400 | Corpo, valor de campo, descrição. |
| `caption` | Geist 12/16 | 500 | Metadado, rótulo de filtro, etiqueta e contador. |
| `stat/lg` | Archivo Expanded 36/40 | 800 | O número de um bloco de resumo, sempre com a ação que ele pede ao lado (seção 25.4). |

Degraus mantidos até cada tela ser refeita (apontam para a escala nova e saem quando ninguém mais os usa): `heading/md` = `heading/lg`, `label/sm` = `caption`, `body/lg` Geist 16/24 400, `label/md` Geist 14/21 500, `button/md` Geist 14/21 600. Tela nova e tela refeita usam só os sete degraus da tabela; `button/md` é do texto de botão, aba e pílula de ação, e fica dentro dos componentes de `packages/ui`.

Regras: no máximo três tamanhos por tela; título com mais espaço acima que abaixo; corpo até 70 caracteres por linha; tracking nunca abaixo de -0,02em (hoje nenhum degrau define `letter-spacing`). Números são tabulares (`font-variant-numeric: tabular-nums` na raiz), mas o shorthand `font` reseta essa propriedade: a regra que aplica um degrau e mostra número a repete (`Pill`, `FormatTag`, `StatusTag` e `LateBadge` já o fazem).

## 11. Shadows / elevation

Implementado em `semantic.css`, em dois degraus suaves e nenhum outro:

```
shadow/raised   = 0 1px 2px rgb(17 24 39 / .04), 0 8px 24px -12px rgb(55 48 163 / .18)
shadow/floating = 0 24px 48px -16px rgb(17 24 39 / .22), 0 2px 8px rgb(17 24 39 / .08)
scrim           = rgb(17 24 39 / .42)   (atrás do diálogo, sem blur)
```

`shadow/raised` é do que o dedo alcança: o botão primário no hover, a opção escolhida do `Segmented`, a aba aberta e o card de crachá no hover. `shadow/floating` é do que flutua: o menu, o cartão do hover (`Popover`), o diálogo e o aviso de marco. O resto se separa por luminosidade e borda, em quatro níveis:

| Nível | Cor | Separação |
|---|---|---|
| 0 · canvas | `bg/canvas` `cloud/100` | o fundo da tela e a navegação lateral |
| 1 · superfície | `bg/surface` `white` | painel, card e campo, com a borda `border/default` quando precisa de limite |
| 2 · elevado | `bg/elevated` `white` | o que fica sobre a superfície; o hover usa `bg/hover` (`indigo/50`) |
| 3 · flutuante | `bg/elevated` + `shadow/floating` | menu, `Popover` e diálogo |

As bordas `border/default` e `border/subtle` são **decorativas**: separam, mas não são o limite de um controle (esse é `border/control`, seções 13.2 e 20.1). Não criar sombra de card parada, de botão parado nem de painel: sombra só aparece no hover, no que foi escolhido e no que flutua.

## 12. Motion

Implementado em [`apps/web/src/styles/tokens/motion.css`](../apps/web/src/styles/tokens/motion.css).

```
motion/fast  = 120ms
motion/base  = 180ms
motion/slow  = 240ms
```

```
motion/easing/standard = cubic-bezier(0.16, 1, 0.3, 1)
```

| Token | Onde |
|---|---|
| `motion/fast` | cor de hover e de troca de aba, filtro, item do `ClientStrip`; a entrada do `Popover` |
| `motion/base` | a entrada do `Dialog`: opacidade e 8 px de subida (`ui-float-in`) |
| `motion/slow` | o giro do indicador de carregando e a varredura do `Realce` (`sweep`), com `motion/easing/standard` |

Há **dois gestos autorais**: o `Realce` entra varrendo da esquerda quando algo vira a vez de quem olha ou é aprovado, e o marco entra com a trilha e o confete (seção 27). O resto é instantâneo ou só de cor, com uma exceção deliberada: o ícone do palco 3D flutua devagar (seção 26). Arrastar um card no calendário não leva transição: o card segue o cursor, sem atraso. `prefers-reduced-motion: reduce` desliga a entrada do modal e do cartão, a varredura do realce, as transições dos controles, o giro do filtro ocupado, a flutuação e a inclinação do palco, as transições e o pulso da trilha e o confete. Os demais indicadores de carregando (botão, pílula e campo) continuam girando, porque avisam que há trabalho em curso. `motion/easing/exit` segue sem valor: fica pendente até um componente precisar dele. Motion explica mudança de estado, expansão, drag-and-drop ou contexto; nunca atrasa uma ação operacional.

## 13. Estratégia de componentes — shadcn + Ageniza

Este projeto **não usa shadcn/ui nem Tailwind hoje**. O dono do produto decidiu em 2026-09-28 (ver [`business/decisions/2026-09-28-o-repositorio-e-a-fonte-do-design-system-com-documento-e.md`](business/decisions/2026-09-28-o-repositorio-e-a-fonte-do-design-system-com-documento-e.md)) que a parte B adota shadcn/ui, copiado para o repositório como base de mecânica e acessibilidade, com as variáveis do shadcn como ponte para os tokens Ageniza (seção 15). Até a parte B entrar, a mecânica é própria (HTML nativo, `<dialog>`, rádio, `aria-*`) e os tokens são os da Ageniza:

- Ageniza define tokens, aparência, semântica e API pública;
- construir no Figma, quando existir, só os componentes que uma tela real exigir;
- promover/adaptar componentes conforme a UI divergir do padrão original.

> shadcn define a mecânica do primitive; Ageniza define semântica, aparência e API pública.

Todos os componentes abaixo moram em [`packages/ui`](../packages/ui/src/index.tsx), usam só tokens e têm uma entrada no registro da página `/design-system` (seção 24). **Antes de criar um componente, confira esta lista**: uma tela que monta um botão, uma etiqueta ou um vazio à mão está quebrando a seção 14. No desktop, o ícone é sempre de `lucide-react`, o único conjunto dessa interface: 20 px na interface e 16 px dentro de pílula, aba e etiqueta (12 px), traço 1,75. Ele fica fora da árvore de acessibilidade (`aria-hidden`), então o rótulo continua sendo o nome do controle.

### 13.1 Ação

| Precisa de | Use | Regra |
|---|---|---|
| A ação principal de um bloco | `Button` `variant="primary"` | Uma **por bloco** (cabeçalho, cartão, painel), em índigo cheio: a regra de "uma por tela" passou a "uma por bloco" em 11/11/2026 (decisão `2026-11-11-o-visual-segue-o-quadro-r0-semana-no-domingo-capa-no-card-e-uma-primaria-por-bloco`, item 4). As demais ações do bloco são secundárias ou terciárias, e blocos vizinhos não competem: o primário de cada um é o destino principal dele. Três primárias lado a lado (três cartões "Assinar") deixam de ser aceitas como exceção. |
| Uma ação ao lado da principal | `Button` `secondary` (tom suave da marca) ou `ghost` (só texto) | Secundária em `indigo/100` com texto `indigo/800`, terciária só texto. |
| Apagar, arquivar, encerrar | `Button` `destructive` | Dano real, depois de confirmação (`ConfirmDialog`). |
| Ação só com ícone | `IconButton` | Exige `label`, que vira `aria-label` e dica de passar o mouse. |
| Ir para outra tela com cara de botão | `ButtonLink` | Um `<a>` de verdade, ou o componente de `as` (`as={Link} to="/clientes"`); nunca a string de classes copiada. Desativado, vira um `span` com `aria-disabled`, sem endereço e fora da ordem de tabulação. |
| Um contador ou rótulo curto | `Pill` | Estático; `tone="accent"` só nos usos do realce (seção 25.2). |
| A próxima ação de um card | `PillAction` | Em cápsula, com os estados do `Button`. |

`Button` aceita `variant` (`primary`, `secondary`, `ghost`, `destructive`), `size` (`sm` 32 px, `md` 44 px, `lg` 52 px de altura), `leadingIcon`, `trailingIcon` e `loading`. O `variant` `outline` do shadcn corresponde ao nosso `secondary`; não expor `outline` como API pública da aplicação. Evitar cópias soltas como `Button Blue`, `Button New`, `Button Final 2`.

**Duas adaptações provisórias** no `Button`, até existirem os tokens que o vocabulário prevê: o hover de `destructive` ainda usa `filter: brightness(0.94)` no lugar de `action/danger/hover`, e o `Segmented` e a aba desativados se apagam com `opacity: 0.55`; o `Button` e o `PillAction` desativados usam o par `action/disabled`, **sem `opacity` por cima**, para o texto ter o contraste de 20.1 (4.65:1), e o `Button` `ghost` desativado fica sem fundo, como a ação só de texto que é. O hover de `primary` usa `action/primary/hover` e sobe 1 px com `shadow/raised`. No loading, o botão fica com `aria-busy` e `aria-disabled` (nunca `disabled` nativo, que tira o foco do teclado de quem acabou de acioná-lo), o clique não faz nada, e o rótulo fica transparente sem sair da árvore de acessibilidade, para o spinner aparecer na cor do variant. `PillAction` e `Segmented` seguem a mesma regra.

### 13.2 Dado e filtro

| Precisa de | Use | Regra |
|---|---|---|
| Texto numa linha, texto longo, escolha numa lista | `TextInput`, `Textarea`, `Select` | Passthrough nativo (classes `ui-text-input`, `ui-textarea` e `ui-select`), com foco visível pela regra global de `:focus-visible`. |
| Rótulo, dica, contador e erro de um campo | `Field` | Entrega ao controle `id`, `aria-describedby` (dica, contador e erro, nessa ordem), `aria-invalid` e `aria-busy` por `{(control) => <TextInput {...control} />}`; o erro leva ícone e texto e é lido pela descrição do campo, sem `role` próprio, e passar do limite do contador também marca o controle como inválido. Quando um envio é recusado, a tela leva o foco ao primeiro campo inválido e, com dois ou mais, mostra um único `ErrorSummary` (um `role="alert"` acima dos campos: "Corrija 3 campos: …"), ambos por `useFormErrors` (decisão de 2026-10-15). `Select` já usa `Field` e aceita `hint`, `error` e `loading`. |
| Escolher um item entre poucos, com contexto | `ChoiceCard` | O cartão inteiro é o botão (nome e descrição). |
| Filtros em faixa | `FilterBar` com `FilterBarSelect` ou `FilterBarItem` | O rótulo pequeno em cima, a escolha embaixo, divisórias entre os filtros; no celular os filtros empilham com divisórias horizontais. `FilterBarSelect` é o `select` nativo, plano; `FilterBarItem` recebe qualquer outro controle e entrega `id`, `className` e `aria-busy` por `{(control) => …}`. |
| Um dia (uma data) | `DatePicker` | Dentro de um `Field`: `<Field label="Dia dos stories">{(control) => <DatePicker {...control} today={hoje} value={dia} onChange={setDia} />}</Field>`. O valor é sempre `aaaa-mm-dd` (ou vazio, enquanto o texto não for um dia inteiro e real) e o `today` é o dia de `America/Sao_Paulo` que o chamador calcula: o componente nunca lê o fuso do navegador. Campo de texto em `dd/mm/aaaa` com máscara (um `aaaa-mm-dd` colado também vale) e um botão que abre um calendário de seis semanas, **domingo primeiro** (desde 11/11/2026, por coerência com a semana do calendário e do portal: decisão `2026-11-11-o-visual-segue-o-quadro-r0-semana-no-domingo-capa-no-card-e-uma-primaria-por-bloco`, item 1; era segunda), com células de 44 px. Teclado: setas, Home e End (começo e fim da semana), Page Up e Page Down (mês; com Shift, ano), Enter e Espaço escolhem, Alt+Seta para baixo abre, Esc fecha **só o calendário** (cancela a tecla, para o modal em volta não fechar junto) e devolve o foco ao botão. `min` e `max` desativam os dias fora do intervalo no calendário; digitado, é a validação de quem chama que recusa. O índigo cheio é só do hoje; o dia escolhido se preenche em tinta. Nunca `<input type="date">` (decisão de 2026-10-16). |
| Várias páginas de resultado | `Pagination` | Até sete páginas aparecem todas; acima disso, as pontas ficam fixas e uma janela acompanha a atual. |

**Borda de controle.** A borda de `input`, `select`, `textarea`, `ChoiceCard` e do `TextInput` dentro de uma `FilterBar` é o limite de um componente de interface e precisa de 3:1 sobre a superfície (WCAG 1.4.11): usa `border/control` (`#6D7989`). As demais bordas são **decorativas** e ficam em `border/default` ou `border/subtle`: separam, não delimitam um controle. Os números estão na seção 20.1; `border/control` passa em `bg/canvas`, `bg/surface` e `bg/hover`. O hover de um campo escurece a borda (`text/muted`) e pinta o fundo de `bg/hover`, onde `border/control` ainda passa (3.97:1); o estado inválido muda só a cor da borda, para o 3:1 nunca se perder; em foco, o campo volta ao fundo `bg/surface`, vira a borda para `focus/ring` e soma o halo `focus/halo` de 4 px ao anel global.

### 13.3 Navegação e escolha de visão

| Precisa de | Use | Regra |
|---|---|---|
| Alternar entre duas ou três visões da mesma coisa (Grade e Lista) | `Segmented` | Grupo de rádio, uma parada de tabulação e setas. A opção escolhida leva superfície branca, sombra suave (`shadow/raised`) e peso 600, não só cor. |
| Dividir uma tela em seções | `Tabs` | Ativação automática: setas movem e abrem, Home e End vão às pontas, aba desabilitada é pulada. A trilha é uma cápsula em `bg/tint` e a aba aberta vira uma superfície branca com sombra suave (`shadow/raised`), com o texto na tinta da ação secundária e peso 600, nunca em índigo e sem sublinhado. `keepMounted` numa aba mantém o painel dela montado e oculto enquanto outra está aberta, para o que foi digitado sobreviver à visita (o formulário do modal do conteúdo). |
| Escolher o cliente em que se trabalha | `ClientStrip` | Os clientes como stories, em `<nav>` com um link de verdade por cliente (`href` obrigatório). O aberto leva `aria-current="page"`, uma superfície e o `Realce` no nome. `renderLink` deixa a tela desenhar o link com o roteador. |
| Ações de um item (os três pontos) | `Menu`, `MenuItem`, `MenuSeparator` | Menu de botão: setas, Home e End movem, Esc fecha; o foco volta ao gatilho. |

O shell da agência (`AgencySidebar`, em `apps/web/src/agency-nav.tsx`) é código do app, não de `packages/ui`: navegação lateral com grupos Trabalho e Agência, o logo no topo, a pessoa e Sair no pé (seção 19).

**Crachá do cliente (#636).** A carteira é uma grade de crachás (3 colunas a partir de 80 rem, 2 a partir de 48 rem, 1 abaixo), só com tokens e os componentes acima, sem componente novo em `packages/ui`. O topo do crachá é o `Avatar` grande (foto ou iniciais) sobre `bg/elevated`, com a base em `client-badge/fade/{start,end}`: nome em branco e @ em `color/slate/300` (6,4:1 ou mais sobre as duas pontas), sem brilho nem vidro. O selo de triagem é um só, na ordem atrasado (`LateBadge`), prazo em até 2 dias e convite pendente (`Pill` com ícone); o que não virou selo continua como etiqueta no corpo. Os três números de conteúdo ficam sobre `bg/canvas`, onde `text/muted` e `text/danger` estão garantidos, e a próxima ação é um `PillAction` neutro (o índigo cheio fica com a ação da página, `Cadastrar cliente`). O link do crachá leva a foto, o nome e as etiquetas e tem o nome do cliente como nome acessível; o menu de três pontos e a ação são botões ao lado dele, nunca dentro. O crachá não leva `overflow: hidden`, porque o menu abre por cima dele. A tela usa 48 (título), 22 ("Seus clientes" e nome) e 14 px, e o 12 px só dos componentes (rótulo do filtro, `Pill`) e dos rótulos dos números.

**Equipe (#638).** A grade da equipe fala a língua do crachá do cliente, sem o degradê (que é a exceção 1 de 25.3, só do crachá do cliente). O `BadgeCard` tem o `Avatar` sobre uma capa `bg/tint`, o nome em `heading/lg`, o cargo em `text/secondary` e o papel numa etiqueta **colorida por papel**, do conjunto dos blocos de cor suave e sempre com o nome do papel (a cor só identifica e não diz de quem é a vez; o papel sem cor própria fica no cinza), e a dona da agência com o ícone `Crown` e "Dona da agência" (decisão `2026-11-11-o-visual-segue-o-quadro-r0-semana-no-domingo-capa-no-card-e-uma-primaria-por-bloco`, item 5; antes era uma `Pill` neutra com `ShieldCheck`); quem foi removido ganha o ícone `UserMinus` e a palavra "removido". A grade usa `repeat(auto-fill, minmax(12rem, 1fr))` abaixo de 64 rem e três colunas a partir dele: com o mínimo, uma tela larga abriria cinco colunas e a última linha de uma página de 24 pessoas ficaria quebrada. O link do crachá reage pela borda (`focus-ring`), nunca pelo fundo, porque a cápsula e o texto mudo só estão garantidos sobre `bg/surface`. Busca e filtros são uma `FilterBar` em grade (a busca na linha de cima, os selects embaixo, sem divisórias), e o título encolhe no celular (`clamp`) para "Colaboradores" caber nos 358 px. Os convites pendentes são uma superfície com linhas separadas por linha divisória (nenhum card dentro de card): o papel é uma `Pill` com ícone, o prazo leva o relógio e, vencido, `text/danger`; o vazio é um `EmptyState` com "Convidar" em `secondary` (a ação primária da página é uma só) e a coruja só na primeira visita, com a pessoa sozinha na equipe e sem filtro, nunca com a equipe cheia. O detalhe e o perfil próprio usam `Tabs` (Performance e Entregas desabilitadas, com a razão por escrito logo abaixo); o convite e a reativação são `Dialog` `sm` em `bg/surface`, com a ação primária por último no pé, ligada ao formulário pelo atributo `form`. A tela usa 48 (título), 22 (nomes e "Convites aguardando aceite") e 14 px, e o 12 px só dos componentes.

### 13.4 Camadas

| Precisa de | Use | Regra |
|---|---|---|
| Uma tarefa que exige interrupção e foco protegido | `Dialog` (`Modal` é o mesmo componente, para as telas que ainda não migraram) | Sobre o `<dialog>` nativo: título, `description` opcional, `actions` no pé (a ação primária por último), `size` `sm`, `md` ou `lg` (28, 40 e 52 rem), raio `xl`, `shadow/floating` e entrada de 180 ms. Uma tarefa que não precisa de interrupção não é modal. Com `confirmDiscard={{ dirty }}`, um formulário com dado digitado não fecha por Esc, clique fora nem X sem perguntar: abre um `Dialog` `sm` "Descartar o que você escreveu?", com "Continuar editando" como ação primária (por último) e "Descartar" como ação perigosa; vazio fecha direto e o sucesso do formulário fecha pelo `onClose` do próprio chamador, sem perguntar (decisão `2026-11-10-cartao-de-conteudo-enxuto-e-fechamento-seguro-de-formulario`). O `dirty` vem de quem chama e vale falso enquanto grava. |
| Confirmar uma ação destrutiva | `ConfirmDialog` | Confirmação de tela cheia sobre `bg/canvas`, com borda de dano; o foco começa em cancelar, Esc cancela e a ação destrutiva aceita `busy`. |
| Um cartão ancorado ao gatilho (o hover do calendário) | `Popover` | Abre ao clique ou, com `openOn="hover"`, depois de 300 ms com o mouse parado ou na hora no foco do teclado, nunca no toque; só fecha 150 ms depois de o mouse sair (`hoverLeaveDelay`), tempo de atravessar o vão de 8 px até o cartão sem que ele suma (WCAG 1.4.13); Esc e um clique fora fecham e devolvem o foco ao gatilho. Não troca de lado na borda da tela: quem usa escolhe o `placement` com espaço. |

O `Popover`, o `Dialog`, o `ConfirmDialog` e o menu ficam em `bg/surface` ou `bg/elevated`, ambos brancos: link, erro e campo passam (20.1) e o `Popover` ainda assim leva texto e ações, não campos. O mesmo vale para qualquer cartão sobre `bg/hover`, onde as três cores também passam. Sobre um bloco de cor ou `bg/tint`, não use `text/link` nem `text/danger`: use `text/primary` ou o `-fg` do bloco. Nenhum export de `packages/ui` leva o nome de um global do JS (item 69 do checklist).

### 13.5 Conteúdo e estado

As etiquetas são estáticas (sem hover, foco nem carregamento): o texto é quem diz, a cor só ajuda.

| Precisa de | Use | Regra |
|---|---|---|
| O formato de um conteúdo | `FormatTag` (`carousel`, `reels`, `static`) | Etiqueta preenchida, par `format/*/tag/{bg,fg}`; o chamador mapeia o formato dele para um desses três. |
| O estado de um conteúdo | `StatusTag` (`ready`, `waiting`, `adjust`, `published`, `production`) | Cápsula suave da família do estado (`status/*/bg` com o texto `status/*/text`), com o ícone `lucide` do estado e o rótulo; o publicado é superfície com fio. O token `status/scheduled/*` existe, mas o componente ainda não tem a variante `scheduled`: ela entra quando uma tela precisar. |
| Atrasado | `LateBadge` ("Atrasado") | O único estado em bloco cheio, no par `action/danger`. |
| Uma pessoa ou um cliente | `Avatar` | Foto ou iniciais, nunca um ícone genérico. `attention` é o motivo em palavras ("em ajuste, em atraso"): desenha o anel (2 px de vão na cor do fundo, depois 2 px em `status/late/fg`) e o diz para a tecnologia assistiva, então o anel nunca é o único sinal. `--ui-avatar-gap` troca a cor do vão quando o fundo não é o canvas. |
| A pessoa da equipe | `BadgeCard` | Exatamente quatro informações: foto ou iniciais, nome, cargo e papel (mais o marcador de removido); um quinto dado vira tabela, o que a SPEC de colaboradores recusa. |
| A palavra que pede decisão agora | `Realce` | Seção 25.2. |
| Um ícone 3D num ponto de ênfase | `Stage3D` | Seção 26: só em resumo, jornada, marcos, pastas e vazios; ação e navegação continuam `lucide`. |
| Os passos de um marco | `MilestoneTrail` | Seção 27: ponto, linha e visto que mudam pelo estado; a recompensa é do `MilestoneCelebration`. |

**Pastas de mídia (#634).** A aba Mídias do cliente (as pastas, que já foram uma vista de Conteúdos) é só composição, sem componente novo em `packages/ui`: o caminho (`ChevronRight` entre os níveis), a pasta como link com `Folder`, o nome e a `Pill` "Padrão", a mídia em cartão com a miniatura (`bg/hover`, com `Image` ou `Video` no lugar enquanto não há imagem), o rótulo com ícone e, quando o vídeo não está pronto, a `Pill` "Processando vídeo" ou o aviso "Falha no processamento do vídeo" em `text/danger`. Nenhum botão da visão é índigo cheio (a ação primária é a da página). O envio é um `Button` secundário "Enviar mídia" que abre o seletor nativo, escondido da tela e do leitor de tela; o arquivo escolhido fica numa linha com ícone, nome e tamanho, a barra de progresso é neutra (tinta, nunca índigo) com o número em tabular, e o erro leva ícone, texto e "Tentar de novo" quando repetir ajuda (arquivo recusado pede outro arquivo, não o mesmo). Pasta e mídia vazias usam o `EmptyState` compacto e sem mascote, com o botão que resolve; erro de carga leva ícone, texto e "Tentar de novo". No celular a mídia vira linha (miniatura de 5 rem ao lado) com alvos de 44 px, e as grades usam `grid-template-columns` com `minmax(0, 1fr)` ou `repeat(auto-fill, minmax(min(100%, 14rem), 1fr))`, para nenhum filho passar do cartão. A tela usa 22 (títulos), 14 e 12 px.

**Roteiro de stories (#635).** O estado do roteiro usa o `StatusTag`, sem componente novo: rascunho é o círculo vazio (`production`), enviado é o relógio (`waiting`) e gravado é o visto (`ready`), cada um com a sua palavra (Rascunho, Enviado, Gravado); a cor vai só no ícone. O mesmo `StatusTag` marca o dia da grade, a lista "Roteiros de stories" abaixo do calendário e o cabeçalho do modal. O modal é um `Dialog` sobre `bg/surface` com `Field` em cada campo, cada cena num bloco sobre `bg/canvas` (o campo passa nos dois fundos, 20.1) e "Enviar ao cliente" como a única ação primária, por último. A lista e as cenas usam `minmax(0, 1fr)` para o conteúdo largo quebrar dentro do bloco em 390 px. O vazio da lista leva o botão "Novo roteiro", secundário, e não leva o mascote.

**Conversa do conteúdo (#639).** Dentro do modal do conteúdo a conversa fica na `bg/surface` do `Dialog`: as linhas de conversa e as mensagens da agência repousam em `bg/canvas`, a mensagem do cliente leva só a borda `border/default` (o modal não usa `bg/elevated`), e a linha reage pela borda (`focus-ring`) no mouse e no teclado, nunca pelo fundo. O estado da linha é uma `Pill` com ícone (`Clock` quando é a vez de quem olha, `CheckCheck` resolvida, `MessageSquare` aberta), em índigo cheio só na que aguarda quem olha; o mesmo vale para o "N aguardando" do cabeçalho. A caixa de resposta é um `Field`, e "+ conversa" é `Plus` mais a palavra "conversa". O voltar do detalhe do cliente é `ArrowLeft` mais "Clientes", com o nome acessível "Voltar para Clientes".

**O celular do feed (#703).** *Desde 11/11/2026 o aparelho **não fica mais ao lado do calendário**: o calendário ocupa a largura toda e o feed continua na vista Feed do seletor (decisão `2026-11-11-o-visual-segue-o-quadro-r0-semana-no-domingo-capa-no-card-e-uma-primaria-por-bloco`, item 3). O que segue descreve o aparelho e as regras dele, que o desenho da vista Feed e o portal mantêm.* O feed de um cliente é um aparelho desenhado só com tokens e sem componente novo: a moldura é `color/ink/900` com `space/2` de borda e raio duplo de `radius/xl`, a ilha da câmera e a barra de início são formas `radius/full` fora do fluxo, e a tela é `bg/surface` com `space/12` em cima e no mínimo 42 rem de altura, para o vazio continuar parecendo um celular. Tem 22 rem de largura e fica à vista (`position: sticky`) enquanto o mês rola. A grade é de nove em nove (três por três), com a paginação no pé (`IconButton` de 44 px com `aria-disabled` nas pontas, e a faixa "1–9 de N" em tabular), e a página que não enche termina em quadros "nada neste dia": moldura tracejada com o ícone `CalendarX` de 1,5 rem, fora da leitura da tela. Só mostra o que a API entrega (o @, a foto, os três contadores, a grade): nenhum botão que não funciona. As regras do celular ficam sob `.content-phone`, porque o feed do portal usa as mesmas classes das casas.

**A página do link de aprovação (#717).** `/aprovar` é uma página pública, fora da casca de quem entrou, sem componente novo em `packages/ui`: cabeçalho com a marca (sem link), uma coluna de no máximo 40 rem sobre `bg/canvas` e o rodapé com Termos e Privacidade. Cada conteúdo é um cartão `bg/surface` com `border/default` e `radius/lg` (título, `StatusTag`, `FormatTag` e o dia), e o aparelho é o mesmo `.content-phone` do feed, em até 22 rem, sem a altura mínima de 42 rem (a tela do cartão encolhe ao que mostra) e com a mídia inteira num quadro 4:5 (`object-fit: contain`, para a imagem larga não ser cortada nem a alta empurrar o cartão). "Aprovar" é a única ação primária do cartão (índigo cheio, `lg`, ícone `Check`) e "Pedir ajuste" fica ao lado, secundária (`Pencil`), em duas colunas `minmax(0, 1fr) minmax(0, 1.2fr)`; a 390 px nenhum rótulo se corta nem sai do cartão. Quem já foi decidido, está em ajuste, publicado ou em produção fica na seção "Outros conteúdos deste e-mail", sem botões. O aviso de sucesso ou de problema fica acima da lista (`LiveStatus` ou `FieldMessage` em alerta) e recebe o foco; os estados da página (carregando, link inválido, sessão vencida, limite, sem conexão) são o `StatusPanel` ou um alerta com "Tentar de novo". "Criar conta para ver o portal" é um `ButtonLink` secundário no fim.

### 13.6 Vazio, erro e carga

| Precisa de | Use | Regra |
|---|---|---|
| Lista sem nada ainda | `EmptyState` (`title`, `description`, `action`, `mascot` opcional) | Diz o que falta, por quê e o caminho. A primeira visita com ação leva a coruja amigável; busca sem resultado é só texto e "Limpar filtros", sem coruja. |
| Vazio de três tipos | `EmptyState` com `kind` (decisão `2026-11-10-tres-tipos-de-estado-vazio`) | `first-use` (o padrão) convida à ação, sem ícone. `good-news` diz que nada está esperando: ícone `CircleCheck` em `status/ready`. `failure` diz que a consulta não respondeu: o **mascote sério** (11/11/2026, item 6 da decisão do quadro r0; no lugar do ícone `CircleAlert`), `role="alert"` e o botão "Tentar de novo" (`onRetry`) e, quando houver contato, "Avisar o suporte" e o código ("Código 503 · 11 nov, 10h42"); vale na agência e no portal. Enquanto a leitura se repete, a tela passa `retrying` (o `isFetching` da consulta): o botão fica `aria-busy`, mantém o foco e não aceita outro clique, para a repetição em andamento não ser cancelada por um segundo pedido. A falha de lista é sempre este padrão, nunca um botão montado à mão. O estado nunca é só a cor: tem ícone e texto. **Regra: o vazio só afirma "nada pendente" (`good-news`) quando a consulta respondeu e a tela cobre todos os estados pendentes; consulta que falhou é `failure`, nunca vazio.** |
| A coruja | `Mascot` (`friendly` ou `serious`) | O único jeito de pôr a coruja numa tela (a sério também na falha de lista, 11/11/2026): `<img>` WebP com `srcset` 1x/2x, largura e altura da pose e `alt=""`, porque o título ao lado já diz tudo. Uma por tela e nunca numa tela de trabalho cheia (docs/brand.md). |
| Página inteira de erro | `StatusPanel` (do app) | Usa o `Mascot` sério, mas continua sendo página inteira (`main`, `h1`, saída obrigatória) e não vira `EmptyState`. |
| Primeira carga | `Skeleton` | Reserva a forma do conteúdo; decorativo, nunca anunciado. |
| Logo e símbolo | `Logo`, `BrandSymbol` | docs/brand.md: o logo no login e no topo da navegação aberta, o símbolo chapado no trilho recolhido. |

Erro leva "Tentar de novo"; vazio leva o que falta e um botão. Os três estados (carregando, erro e vazio) têm teste com asserção do texto (item 16 do checklist).

## 14. Regra de composição

Preferir:

```
Foundation
→ Component
→ Pattern
→ Screen
```

Não fazer:

```
Screen
→ estilos locais
→ cores locais
→ espaçamentos locais
→ componente exclusivo sem necessidade
```

## 15. Estrutura no código

Implementada, adaptada da recomendação original ao que este repositório precisava:

```
apps/web/src/styles/
├── tokens/
│   ├── primitives.css   # cor, espaço, radius
│   ├── typography.css   # font-family e a escala tipográfica
│   ├── motion.css       # timing
│   └── semantic.css     # bg/text/border/action/focus/status/block/stage: o tema único, em `:root`
├── base.css              # reset e regras base do documento
├── ui/                   # uma folha por componente de `packages/ui` (button.css, pill.css, avatar.css...)
├── screens/              # uma folha por tela ou área (clients.css, portal-home.css, subscription.css...)
├── globals.css           # só os `@import`, na ordem da cascata
└── read-css.ts           # `readGlobalCss()`: os testes leem o CSS final por ele
```

**Duas adaptações em relação à página original**, registradas aqui para quem for mexer na estrutura depois:

1. A página original juntava cor, espaço, radius, fonte e motion num único bloco `:root` "Primitives" (seção 16). Este repositório separa fonte em `typography.css` e motion em `motion.css`, seguindo a própria árvore de pastas que a página descrevia (seção 15 dela), que já previa os quatro arquivos.
2. A página original dava Light e Dark como dois blocos CSS paralelos. O app tem um tema só, então os valores ficam em `tokens/semantic.css`, no `:root`, e a pasta `themes/` não existe mais.

`apps/web/src/main.tsx` importa só `./styles/globals.css`; os outros arquivos entram por `@import` dentro dele, na ordem: fontes → primitives → typography → motion → semantic → `base.css` → as folhas de `ui/` e `screens/`.

**Onde vai o CSS novo.**

- **Componente novo de `packages/ui`:** uma folha nova em `styles/ui/<componente>.css`. O pacote não tem CSS próprio.
- **Tela ou área nova:** uma folha nova em `styles/screens/<tela>.css`. Uma tela não põe regra em `ui/` e um componente não põe regra em `screens/`.
- **Depois, registre a folha em `globals.css`** com um `@import` no ponto da ordem em que ela pertence.
- **A ordem dos `@import` é a cascata.** O CSS final é a concatenação das folhas nessa ordem, e com a mesma especificidade vence a regra que vem depois. Uma regra que precisa vir depois de outra fica depois dela; mudar a ordem muda o visual. Não reordene os `@import` sem conferir a tela.
- Os testes de estilo (`components.test.ts`, `tokens.test.ts` e os de tela) leem o CSS por `readGlobalCss()` (`styles/read-css.ts`), que segue os `@import`: uma folha nova entra nos testes sem mudar o teste.

Se o projeto adotar Tailwind, shadcn ou outra camada, os valores dela devem apontar para estas variáveis em vez de criar uma segunda paleta independente. No shadcn, variáveis como `--primary`, `--muted-foreground` e `--ring` funcionariam só como **ponte** em `globals.css`, apontando para os tokens Ageniza:

```css
--primary: var(--action-primary-bg);
--primary-foreground: var(--action-primary-fg);
--ring: var(--focus-ring);
```

Nunca manter uma paleta shadcn paralela.

## 16. CSS custom properties

Os valores vivem nos arquivos listados na seção 15, não duplicados aqui — uma cópia nesta página divergiria do código na primeira mudança, e o repositório é a fonte de verdade (seção 2). Para conferir o nome exato de um token, leia o arquivo correspondente.

Exemplo de como um componente consome os três arquivos (`Button`, variant `primary`, tamanho `md`):

```css
.ui-button--primary {
  background: var(--action-primary-bg);
  color: var(--action-primary-fg);
}
.ui-button--md {
  min-height: 2.75rem;
  padding: 0 var(--space-4);
  border-radius: var(--radius-md);
  font: var(--button-md);
}
```

## 17. Regra crítica de CSS

Componentes preferem **semantic tokens**, não primitives.

Bom:

```css
.button-primary {
  background: var(--action-primary-bg);
  color: var(--action-primary-fg);
  border-radius: var(--radius-md);
}
```

Evitar:

```css
.button-primary {
  background: #4f46e5;
}
```

Isso permite trocar tema e evoluir a marca sem procurar HEX espalhado pelo projeto.

**Exceção conhecida:** o cabeçalho de `.app-shell` usa `color/ink/900` e `color/white` direto, e fica escuro. É o visual herdado da folha de estilo anterior aos tokens, e não há semantic token para uma faixa escura fixa; fica assim até o refino do designer definir o cabeçalho. Os discos do palco 3D usam os tons `color/stage/*`, também primitives, por serem decorativos (seção 26).

## 18. Design tokens no repositório — evolução recomendada

Quando houver necessidade de automação, evoluir para um diretório `design-tokens/` com `color.json`, `spacing.json`, `radius.json`, `typography.json`, `semantic.json`, idealmente em formato compatível com DTCG, permitindo gerar depois CSS variables, tema Tailwind, documentação e eventual sincronização com Figma. Para o MVP, não adicionar pipeline de tokens se isso atrasar produto — a arquitetura atual (arquivos CSS simples, um por camada) não bloqueia essa evolução.

## 19. Grid e responsividade

Desktop-first para operação, com o celular funcional: a navegação da agência vira barra inferior, os filtros empilham, o modal vira coluna. O portal do cliente é celular primeiro (ver `specs/clientes.md`), a exceção deliberada a essa direção, não uma contradição: cada produto (operação vs. portal) tem sua prioridade de breakpoint. O portal entra na Pauta no tema claro (decisão `2026-10-15-portal-na-pauta-tema-claro-sem-tokens-novos`) e, desde 11/11/2026, a agência também: o tema é um só (seção 7).

**Shell da agência** (`.agency-shell` em `styles/screens/agency-shell.css`, `AgencySidebar` em `apps/web/src/agency-nav.tsx`):

| Largura | Navegação | Conteúdo |
|---|---|---|
| a partir de 48 rem | lateral fixa à esquerda, aberta com 248 px (15,5 rem) ou recolhida no trilho de 80 px (5 rem) | até 80 rem, com `space/8` nas laterais |
| abaixo de 48 rem | barra inferior fixa, com a área segura do aparelho (`env(safe-area-inset-bottom)`); cada grupo ocupa a barra em proporção aos itens | `space/4` nas laterais e folga embaixo para a barra |

A navegação abre **recolhida** no calendário de um cliente (a rota `/agencia/:agenciaId/conteudos/:clienteId`), onde o mês precisa da largura, e **aberta** nas demais telas; a escolha explícita da pessoa vale até recarregar a página. Aberta, mostra o logo, o contexto ativo, os grupos (Trabalho: Início, Calendário Editorial, Clientes; Agência: Equipe) e a pessoa com Sair no pé; recolhida, o símbolo chapado e os ícones com o rótulo embaixo; na barra inferior, só os ícones com o rótulo (`label/sm`), sem o logo, o contexto e o Sair solto.

**Breakpoints.** Uma media query não lê custom property, então os valores moram no CSS, em `rem`, e são quatro: `40rem` (celular largo: filtros e vazio empilham), `48rem` (a navegação vira lateral a partir dele e barra inferior abaixo, com `max-width: 47.99rem` como o complemento; o modal do conteúdo vira coluna com `max-width: 48rem`, então em exatos 48 rem já está em coluna e a navegação já é lateral) `64rem` (um painel ao lado do principal: a semana de exemplo das telas de entrada, que abaixo disso ficam em uma coluna só; é também o ponto em que o calendário do Calendário Editorial deixa a agenda por dia e volta à grade de sete colunas) e `80rem` (**o celular ao lado do calendário saiu em 11/11/2026, e este ponto só vale hoje para a grade de crachás; o que segue é o que ele fazia antes**: o celular do feed ao lado do calendário, com largura fixa; abaixo disso ele vai para baixo do calendário, e abaixo de `48rem` ele não aparece: a vista Feed do seletor é o caminho no celular, decisão `2026-11-04-calendario-editorial-tem-mes-semana-e-feed-card-sem-capa-e-celular-so-na-tela-larga`). `40.0625rem` não é um quinto valor: é o complemento de `40rem` (como `47.99rem` é o de `48rem`), usado quando uma regra vale só acima do ponto em que a `FilterBar` empilha, para que em exatos 40 rem as duas não se sobreponham. Uma grade de cards não ganha breakpoint: usa `repeat(auto-fill, minmax(min(100%, <largura do card>), 1fr))` e as colunas seguem o espaço que a navegação deixa (a carteira de clientes, com cards de `20rem`, tem uma coluna a 768 px com a navegação aberta e três a 1440 px). Uma tela nova reaproveita esses quatro; um quinto valor por tela é divergência a discutir, não a decidir localmente.

**Alvo de toque.** O botão `md` tem 44 px de altura e o `lg`, 52 px; o `sm` (32 px) é para linha densa de desktop. No celular, prefira `md` ou maior para o que se toca (é o "área clicável suficiente" da seção 20). Abas e itens de navegação já têm no mínimo 44 px.

**Tela redesenhada, medida no celular.** Em 390 px de viewport emulado (nunca a janela do navegador, que não encolhe tanto), todo controle da versão anterior tem de continuar alcançável: compare `scrollWidth` e os elementos fora da tela com o `develop`. Um painel com `overflow: hidden` ao redor de conteúdo largo esconde controles no celular sem nenhum teste falhar (#657). Quando precisa rolar, o contêiner rola (`overflow-x: auto`) e o anel de foco dos itens fica por dentro.

## 20. Acessibilidade como foundation

Antes de aprovar um componente: contraste adequado; foco visível; estado disabled identificável; área clicável suficiente; label acessível; estado não comunicado só por cor; navegação por teclado quando aplicável. Na Pauta, isso quer dizer, concretamente:

- **Foco.** `:focus-visible` desenha 3 px sólidos em `focus/ring`, a 3 px de distância. Dentro de um contêiner que rola (`Tabs`, `ClientStrip`) o anel vai por dentro (`outline-offset: -3px`), porque um anel por fora seria cortado; o `Segmented` usa 0. `focus/ring` tem 3:1 sobre `bg/canvas`, `bg/surface` e `bg/hover` (20.1); o campo soma o halo `focus/halo` de 4 px e a mudança da cor da borda, sem tirar o anel.
- **Estado nunca só por cor.** Estado de conteúdo vai com ícone e rótulo (`StatusTag`); o anel do `Avatar` vai com o motivo em palavras no nome do link; o cliente aberto leva `aria-current` e superfície além do `Realce`; a opção escolhida do `Segmented` leva superfície, sombra e peso 600.
- **Carregando** é `aria-busy` com `aria-disabled` e uma guarda no clique, nunca `disabled` nativo, que tira o foco de quem acabou de acionar o controle (item 70 do checklist). O filtro e o campo continuam usáveis e dizem que estão ocupados.
- **Nome acessível contém o texto visível** do controle: o rótulo do botão, a dica de um `IconButton` e o motivo do anel de atenção depois do nome do cliente.
- **Movimento reduzido** (`prefers-reduced-motion: reduce`) desliga as transições dos controles, a entrada de modal e cartão, a varredura do `Realce`, a flutuação e a inclinação do palco 3D, as transições e o pulso da trilha de marco e o confete (seções 12, 26 e 27). O estado final aparece de uma vez.
- **Texto sobre bloco de cor.** Sobre um bloco de cor ou `bg/tint`, o texto é `text/primary` ou o `-fg` do próprio bloco; `text/link`, `text/danger` e `text/muted` só têm contraste garantido sobre `bg/canvas`, `bg/surface` e `bg/hover` (20.1).

### 20.1 Contraste — tabela final, refeita em 11/11/2026

Pares de texto sobre fundo contra WCAG AA (4.5:1 para texto normal, 3:1 para texto grande e componentes de UI), recalculados com os valores finais do CSS (fórmula de luminância relativa do WCAG 2.x, mistura do `color-mix` em sRGB). **Todos os pares em uso passam.** A tabela vale para o tema único (seção 7); o teste `apps/web/src/styles/tokens.test.ts` lê as tabelas desta seção e reprova quando uma razão citada diverge do que as folhas de estilo calculam: mudou um token, a tabela muda no mesmo PR. O palco 3D e o confete são decorativos e ficam fora da tabela.

| Par | Razão |
|---|---|
| `text/primary` sobre `bg/canvas` / `bg/surface` / `bg/hover` / `bg/tint` | 16.16:1 / 17.74:1 / 15.93:1 / 14.33:1 |
| `text/secondary` sobre `bg/canvas` / `bg/surface` / `bg/hover` / `bg/tint` | 6.90:1 / 7.58:1 / 6.81:1 / 6.12:1 |
| `text/muted` sobre `bg/canvas` / `bg/surface` / `bg/hover` | 4.58:1 / 5.03:1 / 4.52:1 |
| `text/link` sobre `bg/canvas` / `bg/surface` / `bg/hover` | 5.73:1 / 6.29:1 / 5.65:1 |
| `text/danger` sobre `bg/canvas` / `bg/surface` / `bg/hover` | 5.99:1 / 6.57:1 / 5.90:1 |
| `action/primary/fg` sobre `action/primary/bg` / `action/primary/hover` | 6.29:1 / 7.90:1 |
| `action/secondary/fg` sobre `action/secondary/bg` / `action/secondary/hover` | 8.02:1 / 6.55:1 |
| `action/danger/fg` sobre `action/danger/bg` | 6.57:1 |
| `action/disabled/fg` sobre `action/disabled/bg` | 4.65:1 |

Os pares de `action/primary` valem para o `Button`, a `Pill` e a `PillAction` de `tone="accent"` e o `Realce`; os de `action/secondary`, para o `Button` secundário; os de `action/danger`, para o `Button` destrutivo e o `LateBadge`. `text/muted` sobre `bg/hover` (4.52:1) é o par de texto aprovado mais apertado: qualquer mudança em `color/slate/500` ou `color/indigo/50` precisa reconferi-lo.

**Não-texto (3:1).** Limites de controle, anel de foco e anel de atenção do avatar. `border/control` é o limite de `input`, `select`, `textarea`, `ChoiceCard` e do campo de texto da `FilterBar` (WCAG 1.4.11); as bordas decorativas ficam abaixo de 3:1 de propósito, porque não delimitam um controle.

| Par | Razão |
|---|---|
| `border/control` sobre `bg/canvas` / `bg/surface` / `bg/hover` | 4.03:1 / 4.42:1 / 3.97:1 |
| `focus/ring` sobre `bg/canvas` / `bg/surface` / `bg/hover` | 5.73:1 / 6.29:1 / 5.65:1 |
| Anel de atenção do avatar (`status/late/fg`) sobre `bg/canvas` / `bg/surface` | 5.99:1 / 6.57:1 |
| `border/default` sobre `bg/canvas` / `bg/surface` (decorativa) | 1.08:1 / 1.18:1 |
| `border/subtle` sobre `bg/canvas` / `bg/surface` (decorativa) | 1.01:1 / 1.08:1 |

O anel do avatar sobre `bg/hover` é o do item aberto ou sob o mouse no `ClientStrip` (o vão troca para a cor do item por `--ui-avatar-gap`); é o mesmo vermelho do `text/danger`, então vale os 5.90:1 dele.

**Estado, formato, bloco e crachá.** Ícone de estado é não-texto (3:1); a cápsula suave, o bloco, o título e a etiqueta de formato são texto (4,5:1).

| Par | Razão |
|---|---|
| `status/ready/fg` sobre `bg/canvas` / `bg/surface` | 4.99:1 / 5.47:1 |
| `status/waiting/fg` sobre `bg/canvas` / `bg/surface` | 5.19:1 / 5.70:1 |
| `status/adjust/fg` sobre `bg/canvas` / `bg/surface` | 5.73:1 / 6.29:1 |
| `status/scheduled/fg` sobre `bg/canvas` / `bg/surface` | 5.41:1 / 5.93:1 |
| `status/late/fg` sobre `bg/canvas` / `bg/surface` | 5.99:1 / 6.57:1 |
| `status/published/fg` sobre `bg/canvas` / `bg/surface` | 6.90:1 / 7.58:1 |
| `status/production/fg` sobre `bg/canvas` / `bg/surface` | 4.58:1 / 5.03:1 |
| `status/production/text` sobre `status/production/bg` | 9.15:1 |
| `status/adjust/text` sobre `status/adjust/bg` | 8.02:1 |
| `status/waiting/text` sobre `status/waiting/bg` | 7.27:1 |
| `status/ready/text` sobre `status/ready/bg` | 6.56:1 |
| `status/scheduled/text` sobre `status/scheduled/bg` | 7.41:1 |
| `status/late/text` sobre `status/late/bg` | 6.57:1 |
| `block/indigo/fg` sobre `block/indigo/bg` | 8.02:1 |
| `block/violet/fg` sobre `block/violet/bg` | 7.27:1 |
| `block/teal/fg` sobre `block/teal/bg` | 6.56:1 |
| `block/sky/fg` sobre `block/sky/bg` | 7.41:1 |
| `block/red/fg` sobre `block/red/bg` | 7.47:1 |
| `block/slate/fg` sobre `block/slate/bg` | 9.15:1 |
| `text/primary` sobre `block/{indigo,violet,teal,sky,red,slate}/bg` | 14.33:1 · 14.36:1 · 15.34:1 · 15.04:1 · 14.60:1 · 15.67:1 |
| `text/secondary` sobre `block/{violet,teal,sky,red,slate}/bg` | 6.13:1 · 6.55:1 · 6.42:1 · 6.24:1 · 6.69:1 |
| `format/carousel/fg` sobre `format/carousel/bg` | 6.56:1 |
| `format/reels/fg` sobre `format/reels/bg` | 7.27:1 |
| `format/static/fg` sobre `format/static/bg` | 9.15:1 |
| `format/carousel/tag/fg` sobre `format/carousel/tag/bg` | 5.47:1 |
| `format/reels/tag/fg` sobre `format/reels/tag/bg` | 5.70:1 |
| `format/static/tag/fg` sobre `format/static/tag/bg` | 7.58:1 |
| `text/secondary` sobre `format/{carousel,reels,static}/bg` | 6.55:1 · 6.13:1 · 6.69:1 |
| `text/primary` sobre `calendar/today/bg` | 14.33:1 |
| branco sobre `client-badge/fade/start` / `end` | 9.96:1 / 9.53:1 (o crachá é escuro) |
| `color/slate/300` sobre `client-badge/fade/start` / `end` | 6.71:1 / 6.42:1 |
| `color/teal/700` sobre `bg/surface` | 5.47:1 |

O rótulo de um `StatusTag` é o `status/*/text` sobre o seu `status/*/bg`; o da `Pill` neutra, `text/secondary` sobre `bg/hover`. O `text/secondary` sobre o bloco índigo é o de `bg/tint` (mesma cor, 6.12:1).

**Restrição de uso, não falha:** `text/link`, `text/danger` e `text/muted` não foram conferidos sobre os blocos de cor nem sobre `bg/tint`; ali o texto é `text/primary` ou o `-fg` do bloco (seção 6). Se uma tela real precisar de link ou erro sobre um bloco, isso volta a ser um ponto em aberto: confira o par, não aprove em silêncio.

**Histórico.** A tabela de 2026-09-28 corrigiu quatro pares do tema escuro e do claro que reprovavam (`text/muted` sobre `bg/hover`, `text/link` e `text/danger` no escuro). Com o tema escuro removido em 11/11/2026, só o claro continua aqui, recalculado; a razão de cada decisão antiga está em `docs/business/decisions/`.

## 21. Handoff Figma → código

Vale a partir do momento em que existir um arquivo Figma. Um componente está pronto para desenvolvimento quando tem: nome final; tokens aplicados; estados relevantes; variants necessárias; comportamento responsivo descrito quando necessário; exemplo de uso; nenhum estilo local arbitrário importante.

No código, o componente preserva o mesmo vocabulário de variants do Figma quando isso fizer sentido:

```
Figma: Button / variant=primary / size=md
Code:  <Button variant="primary" size="md" />
```

## 22. Governança entre design e desenvolvimento

- alteração de token estrutural é discutida, não feita localmente numa tela;
- mudança de token no código é refletida no Figma, quando ele existir;
- mudança de token no Figma, quando ele existir, vira alteração no código antes de ser considerada entregue;
- componente novo reutiliza foundations existentes;
- evitar duplicar componentes só por pequenas diferenças visuais;
- PR que altera foundation visual indica quais tokens/componentes foram alterados.

## 23. Definition of Done de UI — critério de aceite

> **Decidido pelo dono do produto em 2026-09-28.** Esta lista é critério de aceite de toda task `escopo:web`, não uma proposta. A única mudança em relação à versão proposta (que a entrada de fundação deste documento trazia) é a remoção do item de paridade com o Figma: na sequência esboço → código → refino (ver `decisions.md`), o Figma só entra no refino, depois que a tela já está no ar, então não é critério de aceite da implementação inicial. Ver a entrada de 2026-09-28 "O repositório é a fonte do design system, com documento e página viva" em [`decisions.md`](business/decisions.md).

Uma entrega visual de uma task `escopo:web` só está concluída quando:

- [ ] usa tokens oficiais;
- [ ] não contém HEX arbitrário relevante;
- [ ] usa tipografia oficial;
- [ ] respeita a escala de espaço;
- [ ] estados hover/focus/disabled definidos quando aplicável;
- [ ] usa o tema único, claro: nenhum seletor de tema, nenhuma cor escura local e nenhum HEX fora de `primitives.css`;
- [ ] cada bloco (cabeçalho, cartão, painel) tem no máximo uma ação em índigo cheio, nos quatro usos de 25.2 (a regra era "uma por tela" até 11/11/2026);
- [ ] acessibilidade básica validada (seção 20);
- [ ] componente novo foi criado só quando não existia equivalente reutilizável.

Paridade entre Figma e código **não** é critério de aceite aqui: entra no refino de cada tela, depois que ela está no ar, com o designer (ver [`business/decisions/2026-09-28-a-tela-e-implementada-a-partir-do-esboco-e-o-designer.md`](business/decisions/2026-09-28-a-tela-e-implementada-a-partir-do-esboco-e-o-designer.md)).

> A meta não é construir um design system gigantesco antes do produto. A meta é garantir que cada nova tela aumente um sistema consistente, em vez de criar uma nova linguagem visual a cada implementação.

## 24. Página viva `/design-system`

Rota interna, só no servidor de desenvolvimento (`pnpm --filter @ageniza/web dev`, endereço `/design-system`); o build de produção não a contém (ver [`business/decisions/2026-10-14-pagina-design-system-so-no-ambiente-de-desenvolvimento.md`](business/decisions/2026-10-14-pagina-design-system-so-no-ambiente-de-desenvolvimento.md)).

- **Tokens:** cores primitivas, tokens semânticos (um tema só), tipografia, espaço, raio, elevação, os blocos de cor com o palco 3D e movimento. Tudo é lido dos arquivos de `apps/web/src/styles`: token novo aparece sozinho, sem editar a página.
- **Componentes:** `apps/web/src/design-system/components.tsx` guarda um registro. Componente novo em `packages/ui` exige uma entrada nele (o teste `design-system.test.tsx` reprova quando falta e diz o formato; um export em maiúscula que não é componente entra na lista `NOT_COMPONENTS` do teste, com o motivo), com `covers` listando o que exporta e um exemplo por variante; a página monta as colunas Padrão, Hover, Foco, Desativado e Carregando e marca "—" no estado que o componente não tem.

## 25. Regras da Pauta

A direção **Pauta** (épico #621) desenha a área da agência como uma mesa editorial: tudo quieto, e o índigo é o realce que a editora passa só no que pede uma decisão agora. Desde 11/11/2026 a Pauta é clara (decisão `2026-11-11-agencia-passa-a-ser-clara-como-portal-e-entrada`), como o portal e a entrada, e os blocos de cor suave (seção 26) dão a hierarquia sem competir com o realce. As cores da marca não mudam; a distinção vem da tipografia expandida, do realce como gesto único de ação, da disciplina de cor por quem tem a vez e das capas dos posts, que carregam a cor da tela (a interface não compete com o trabalho da agência). Estas regras valem em toda tela da área da agência, **somadas** à Definition of Done da seção 23; o portal do cliente também (decisão `2026-10-15-portal-na-pauta-tema-claro-sem-tokens-novos`). Estão registradas em [`business/decisions/2026-10-13-pauta-quem-tem-a-vez-decide-a-cor-e-as-quatro-excecoes.md`](business/decisions/2026-10-13-pauta-quem-tem-a-vez-decide-a-cor-e-as-quatro-excecoes.md) e [`business/decisions/2026-10-14-o-realce-tem-quatro-usos-incluindo-o-cliente-selecionado.md`](business/decisions/2026-10-14-o-realce-tem-quatro-usos-incluindo-o-cliente-selecionado.md).

### 25.1 Quem tem a vez decide a cor

A cor de um estado do conteúdo diz de quem é a vez. O que está em dia recua para o cinza; o que está travado salta. A carteira e o calendário são painéis de plantão, não relatórios.

| Estado | Ícone | Cor do ícone | A vez é de quem |
|---|---|---|---|
| Em ajuste | `Pencil` | `indigo/600` | da agência: usa a cor da ação |
| Aguardando aprovação | `Clock` | `violet/600` | do cliente |
| Aprovado | `Check` | `teal/700` | aprovado, falta publicar. Antes "Pronto para publicar" (11/11/2026) |
| Agendado | `CalendarClock` | `teal/700` | aprovado **com data e hora futuras**: é derivado de Aprovado, não um estado novo (decisão `2026-11-11-agendado-e-um-estado-derivado-de-aprovado-com-data-e-hora-futuras`); se o ícone não existir em `lucide-react`, o `Check` com o rótulo "Agendado" |
| Atrasado | `LateBadge` | `action/danger` cheio, texto branco | de ninguém: precisa saltar; o único estado em bloco cheio |
| Publicado | `CheckCheck` | `slate/600` | de ninguém: feito fica quieto |
| Em produção | `Circle` | `slate/500` | neutro |

- A cor diz de quem é a vez, mas o estado nunca é só cor: a cápsula suave leva o ícone e o rótulo (`StatusTag`), e o ícone solto usa `status/*/fg` (não-texto, 3:1).
- Erro é `text/danger` e diz como sair ("Tentar de novo").
- **Dentro do card do calendário** o fundo e o título são tingidos pelo **formato** (`format/{carousel,reels,static}/{bg,fg}`), e o estado vive na etiqueta (`StatusTag`), ao lado da etiqueta preenchida do formato (`FormatTag`). **O card tem capa** (11/11/2026): a miniatura do post (nunca o original; sem capa, o ícone do formato), com o ícone do formato, o título e a etiqueta de estado; a legenda sob o calendário diz "O formato tinge o card; o estado fica na etiqueta". O atrasado passa por cima de tudo, com contorno vermelho no card inteiro, nunca borda lateral (vem com a #631; hoje o CSS só tem o `LateBadge` e `.content-card__badge--overdue`). No canvas, stories, vídeo e VSL não têm tinta: ficam em `bg/elevated`, com etiqueta de contorno.
- **A cor do papel** (Equipe) é identificação, não estado: usa o conjunto dos blocos de cor suave, vem sempre com o nome do papel e não diz de quem é a vez (11/11/2026).
- O índigo fica fora dos formatos de propósito: é da ação e do hoje. Reels e aguardando dividem o violeta, e carrossel e pronto dividem o teal; o ícone e o rótulo desfazem a dúvida.

### 25.2 O realce: quatro usos

O índigo cheio (`action/primary/bg`, no `Button` primário, na `Pill` e `PillAction` de `tone="accent"` e no `Realce`) tem **quatro usos e só eles**:

1. **a ação primária de um bloco**, uma por bloco (cabeçalho, cartão ou painel; era "da tela, uma só" até 11/11/2026);
2. **o hoje** (a célula do dia de hoje no calendário, `calendar/today/bg`);
3. **a vez de quem olha** ("2 posts esperando você"), no `Realce` atrás da palavra que pede a decisão;
4. **o cliente selecionado** no `ClientStrip` (decisão do dono de 2026-10-14: no tema claro, só a superfície dá 1,03:1 e o selecionado some).

Duas manchas de índigo cheio competindo **no mesmo bloco**, fora destes usos, é erro. Não são índigo cheio, e portanto não entram na regra: o ícone do estado em ajuste, o link (`text/link`) e o anel de foco. A aba aberta é uma superfície branca com sombra suave sobre a trilha tingida, nunca em índigo e sem sublinhado. O `Realce` tem cantos desiguais, como caneta marca-texto, e é a única forma fora da escala de raios; ele entra varrendo da esquerda (`sweep`, 240 ms) quando algo vira a vez de quem olha ou é aprovado, e fica parado quando a pessoa pede menos movimento.

### 25.3 Exceções aprovadas pelo dono

A lista anti-slop abaixo tem cinco exceções: as quatro primeiras, aprovadas com o canvas v2 (2026-10-13), e a quinta, do redesenho de 2026-11-11:

1. **Degradê forte só na base do crachá do cliente.** A foto do crachá termina num degradê de índigo e violeta escurecidos sobre `ink/900` (`client-badge/fade/{start,end}`), com branco por cima a 9,5:1 ou mais (9,96:1 e 9,53:1). Sem glow, sem vidro, sem blur. O degradê do símbolo da marca é do arquivo da marca e não vira estilo de interface.
2. **Cor do card por formato e estado na etiqueta** (25.1), em vez de a cor do card dizer o estado.
3. **Pílula (raio cheio) na ação do crachá e nos contadores.** O raio cheio, antes só do avatar, vale também para `Pill` e `PillAction` (seção 9).
4. **Navegação larga com grupos como shell** de toda a agência: aberta com 248 px, recolhível no trilho de 80 px e, no celular, barra inferior (seções 13.3 e 19).
5. **Degradês suaves, só no fundo do `EmptyState` e no disco do palco 3D** (decisão `2026-11-11-nova-linguagem-visual-clara-com-blocos-de-cor-suave`, que substitui o item 2 da decisão de 2026-10-13). O `EmptyState` leva um toque do tom da família sobre `bg/surface` (índigo no primeiro uso, teal na boa notícia); o disco do palco é um `radial-gradient` do tom da família sobre o fundo do cartão (seção 26). Nenhum dos dois é texto, botão nem fundo de página, e não há vidro, glow nem blur decorativo. A barra de progresso indeterminada (`:indeterminate`) anima um traço sobre `bg/hover` e é indicador de carregando, não decoração.

### 25.4 Anti-slop: o que o revisor recusa em toda tela

- **Nenhum gradiente** em texto, botão ou fundo de página (as exceções são a 1 e a 5 de 25.3). Nada de vidro, glow ou blur decorativo; sombra suave só no que o dedo alcança (hover, aba e opção escolhidas) e no que flutua (seção 11).
- **Nenhum rótulo acima do título** (eyebrow) nem numeração 01/02/03. **Exceção (11/11/2026, item 8 da decisão do quadro r0):** o cabeçalho de página pode ter uma **sobrelinha curta de contexto** (a data de hoje no Início, "Agência" na Equipe); é contexto, nunca rótulo decorativo nem numeração.
- **Nenhuma borda colorida lateral** em card, linha ou alerta.
- **Nenhum card dentro de card.** Agrupar por espaço e linha divisória.
- **Nenhum número-herói** (número gigante, rótulo e variação) sem a ação que ele pede.
- **Índigo cheio só nos quatro usos** de 25.2.
- **Nenhum estado vazio mudo.** Sempre o que falta e um botão que resolve; erro com "Tentar de novo"; skeleton na primeira carga.
- **Nenhuma cópia genérica** ("Bem-vindo de volta!", "Explore"). O botão diz o que faz; o erro diz o que houve e como sair.
- **Nenhum ícone genérico de pessoa** no lugar de foto: iniciais. Nenhum emoji nem caractere no lugar de ícone: `lucide-react`, em um traço só.
- **Nenhum padrão do navegador esquecido:** seleção de texto, foco, barra de rolagem e cursor de texto na paleta. Hoje o app só define `accent-color`; o foco é global (seção 20), e seleção, barra de rolagem e cursor entram nas telas da Pauta, com a varredura final (#639) conferindo.
- **Modal só quando a tarefa exige interrupção** e foco protegido (seção 13.4).

Mais as regras de tela da issue do épico: uma única ação primária **por bloco**; no máximo três tamanhos de texto por tela; só tokens de `apps/web/src/styles` (nenhum HEX fora de `primitives.css`); capturas em 1440 e 390 (viewport emulado) ao lado da artboard do canvas.

### Iconografia do app mobile

Por solicitação do responsável de UI/UX, o mobile usa exclusivamente Hugeicons. O vocabulário está em `apps/mobile/src/product/icons.tsx`, sem fallback Lucide. Na web, `HugeIcon.web.tsx` usa os componentes originais de Hugeicons Animated com Motion, fixados em fonte MIT e animando partes internas do SVG. A área inteira do controle responde a hover, toque, clique e foco; desabilitação, movimento reduzido e remoção de listeners são respeitados. Não se atrasa navegação para terminar animações. Ícones passivos não ficam em loop. O bundle nativo mantém os mesmos desenhos em repouso; isso não é uma validação de movimento em aparelho físico.


## 26. Ícone 3D: o palco

Decisão `2026-11-11-icones-3d-no-palco-so-em-pontos-de-enfase`. O ícone 3D é um ponto de ênfase, não um ícone de interface: ele diz "aqui está o que importa" num resumo, numa jornada, num marco, numa pasta ou num vazio (inclusive os do portal). A **falha** de lista também é um ponto de ênfase, com o mascote sério (seção 13.6). Ação e navegação continuam `lucide-react` (seção 13). Nunca em linha de lista, botão, aba, tabela nem menu, e um por bloco.

**Origem e licença.** [3dicons](https://3dicons.co) (realvjy e colaboradores), **CC0 1.0** (domínio público, uso comercial e sem atribuição), estilo `color`, ângulo `dynamic`, 400 × 400. Os 15 PNGs ficam em `apps/web/public/3d/` com o `LICENSE.txt` ao lado: `bell`, `bulb`, `calender`, `clock`, `fav-folder`, `flag`, `folder`, `mail`, `medal`, `new-folder`, `notebook`, `rocket`, `thumb-up`, `tick` e `trophy`. O render é servido **como vem**: nunca se pinta, filtra nem tinge o PNG. O que pertence ao cartão é o disco em que ele se apoia.

**Componente.** `Stage3D` (`packages/ui/src/stage.tsx`):

```tsx
<div data-stage-host className="…" style={{ '--ui-stage-bg': 'var(--block-teal-bg)' }}>
  <Stage3D src="/3d/thumb-up.png" tone="teal" size="lg" />
</div>
```

| Prop | Valores | Regra |
|---|---|---|
| `src` | caminho em `/3d/` | o render original; só o dos 15 acima |
| `size` | `sm` 44 px, `md` 72, `lg` 100 (padrão), `xl` 136 | o disco, a sombra de contato e a caixa saem do tamanho (`--stage-size-*`) |
| `tone` | `indigo`, `violet`, `teal`, `sky`, `red`, `slate` (padrão) | a família do cartão: dá o tom do disco (`--stage-*-tone`) e da borda e sombra (`--stage-*-deep`) |
| `breakout` | `boolean` | o ícone sai pelo topo do cartão; só de `md` para cima e o cartão não pode cortar |

O bloco que hospeda o palco declara o próprio fundo em `--ui-stage-bg` (o disco mistura o tom com ele); sem isso, vale `bg/surface`.

**Comportamento.** O ícone flutua 0,3 rem a cada 4,2 s. Com um ponteiro que paira (`(hover: hover)`) e sem pedido de menos movimento, ele se inclina até 26° e 22° na direção do ponteiro enquanto este está sobre o cartão (`[data-stage-host]`, ou o pai) e volta ao centro ao sair; no toque e com `prefers-reduced-motion: reduce`, fica parado.

**Acessibilidade.** É decorativo: `aria-hidden="true"` (nenhuma prop o desfaz), `alt=""`, `draggable={false}`. O título ao lado diz tudo. Fica fora da tabela de contraste (20.1).

## 27. Marco e recompensa

Decisão `2026-11-11-todo-marco-tem-trilha-e-recompensa`, que complementa a de 2026-11-06 (`caminho-de-ativacao-e-marcos-da-agencia`). Todo marco do produto tem duas partes: a **trilha**, que mostra onde a pessoa está, e a **recompensa**, que reconhece o passo. As regras da de 2026-11-06 continuam: a recompensa nunca bloqueia a tela nem o clique, quem pede menos movimento fica só com a mensagem, e tudo é derivado do dado (nada de "marcar como feito").

**Trilha.** `MilestoneTrail` (`packages/ui/src/milestone-trail.tsx`) é uma lista ordenada (`<ol>`, que a tela nomeia com `aria-label`) de passos `{ id, title, status, when?, description?, action? }`:

| Estado | Ponto | Texto |
|---|---|---|
| `done` | preenchido em teal com o visto | `when`: quando e por quem; sem `action` |
| `current` | anel índigo que pulsa; `aria-current="step"` | `description` e a `action` do caminho |
| `upcoming` | vazio | `description`: o que vem |

O estado é a **única entrada**: com `id` estável, quando um passo vira `done` (e o seguinte `current`) os mesmos elementos mudam de classe e tocam as transições, o ponto se preenche, o visto se desenha, a linha desce até o próximo e o pulso passa para o novo atual. Com movimento reduzido, o mesmo estado final aparece de uma vez. O ponto e a linha são ilustração (`aria-hidden`); o estado vai em palavras antes do título ("Feito: …", "Passo atual: …", "Próximo passo: …"), que a tela pode trocar por `statusLabels`. `size="sm"` desenha a trilha pequena.

**Recompensa.** `MilestoneCelebration` (`apps/web/src/milestone-celebration.tsx`): a primeira aprovação leva o painel e um confete grande (90 peças, 5 s); os outros marcos, um aviso leve e um confete curto (28 peças, 2,5 s). As peças usam o índigo, o violeta e o teal da marca e os tons quentes `celebration/gold` e `celebration/coral`, caem por cima da tela sem pegar clique nem tecla e somem sozinhas. Com `prefers-reduced-motion: reduce`, só a mensagem. A trilha não desenha o confete: quem decide celebrar é o dado, não o componente.
