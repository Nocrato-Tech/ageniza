# Design system

Como a identidade visual da Ageniza vira um sistema de UI consistente entre design e código. O objetivo é impedir que telas criem cor, espaçamento, tipografia e componente de forma independente.

**O repositório é a fonte de verdade — confirmado pelo dono do produto em 2026-09-28.** Até então este conteúdo vivia numa página do Notion, ["UI System — Figma, Design Tokens & CSS"](https://app.notion.com/p/3d886d2ba8b08172a3fbcc31e1548c31) (histórico — não usar como referência de trabalho); a página vira registro histórico, e a fonte passa a ser aqui, com uma página em `/design-system` no próprio app mostrando os tokens e componentes ao vivo (só no servidor de desenvolvimento; ver a seção 24 e a entrada de 2026-09-28 em `decisions.md`). Ver a entrada de 2026-09-28 "O repositório é a fonte do design system, com documento e página viva" em [`decisions.md`](business/decisions.md), que registra as decisões fechadas nesta data. O Notion permanece como registro histórico da decisão original, nunca mais como referência para implementar.

Logo, símbolo e mascote têm documento próprio: [Marca](brand.md).

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
2. **01 — Foundations** — logo e assinaturas aprovadas; cores primitives; cores semânticas Light/Dark; tipografia; grid; spacing; radius; shadows; iconografia; motion guidelines.
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

Modes `Light` e `Dark`. Vocabulário completo (o código implementa o que tem valor real — seções 6 e 7):

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

Implementada em [`apps/web/src/styles/tokens/primitives.css`](../apps/web/src/styles/tokens/primitives.css).

| Token | Valor | Uso conceitual |
|---|---|---|
| `color/ink/900` | `#111827` | base escura / texto forte |
| `color/ink/800` | `#1F2937` | superfície escura |
| `color/ink/700` | `#374151` | superfície escura elevada / hover |
| `color/ink/600` | `#4B5563` | borda no Dark |
| `color/indigo/600` | `#4F46E5` | marca / ação principal Light |
| `color/indigo/550` | `#5B5FE8` | ação principal Dark; mantém contraste com texto branco e superfície |
| `color/indigo/400` | `#818CF8` | anel de foco no Dark; `text/link` no Dark (seção 7 e 20.1) |
| `color/violet/600` | `#7C3AED` | identidade / destaque |
| `color/teal/500` | `#14B8A6` | acento / fluxo |
| `color/slate/600` | `#475569` | texto secundário no Light |
| `color/slate/500` | `#617087` | texto muted no Light |
| `color/slate/400` | `#A1AFC1` | texto muted no Dark |
| `color/slate/300` | `#CBD5E1` | texto secundário no Dark |
| `color/mist/200` | `#E8ECF4` | bordas / superfícies |
| `color/mist/100` | `#F4F6FA` | hover / borda sutil no Light |
| `color/cloud/50` | `#F8FAFC` | canvas claro |
| `color/white` | `#FFFFFF` | branco puro, como token |
| `color/red/700` | `#B42318` | cor de dano (`action/danger/bg`, `text/danger` no Light) |
| `color/red/400` | `#E9675D` | `text/danger` no Dark, só (seção 7 e 20.1) |

### 5.1 Lacuna encontrada nesta migração — valores aprovados em 2026-09-28

A página original referenciava, nas tabelas de semantic tokens (seções 6 e 7) e no bloco de CSS (seção 16), oito tokens sem valor definido em lugar nenhum: `color/mist/100`, `color/ink/800`, `color/ink/700`, `color/ink/600`, `color/slate/300`, `color/slate/400`, `color/indigo/400` e `color/white`. Os valores que a página definia batem exatamente com a paleta Tailwind na mesma família e no mesmo degrau (`slate/600` = Tailwind `slate-600` `#475569`, `indigo/600` = Tailwind `indigo-600` `#4F46E5`, `ink/900` = Tailwind `gray-900` `#111827`, `cloud/50` = Tailwind `slate-50` `#F8FAFC`). Os seis primeiros seguem a mesma família Tailwind, no mesmo degrau que falta (`gray-800/700/600`, `slate-400/300`, `indigo-400`). `color/mist/100` não tem correspondente exato no Tailwind — é a mesma cor de `mist/200`, misturada 50% com branco. `color/white` é `#FFFFFF` literal; a página já o usava, só não o tinha como token nomeado, embora o cite por nome na seção 6.

Um nono valor entrou por necessidade própria desta migração, fora da lista acima e da página original: `color/red/700 = #B42318`, usado em `action/danger/bg`. A página não define nenhuma cor de dano com valor — só a direção ("danger → red") — mas o vocabulário de Button que esta mesma tarefa pede (`variant = primary | secondary | ghost | destructive`) exige uma. `#B42318` é o vermelho que `packages/ui` já usa em produção hoje (antes chamado `tone="danger"`); esta migração o transforma em token, sem mudar o valor.

**O dono do produto aprovou os nove valores em 2026-09-28**, depois de corrigir os pares que falhavam WCAG AA (seção 20.1): `color/slate/500` (Light `text/muted`) foi escurecido de `#64748B` para `#617087`, e `color/slate/400` (Dark `text/muted`) foi clareado de `#94A3B8` para `#A1AFC1` — mesma matiz e saturação da paleta Tailwind original, só a luminosidade mudou, para que `text/muted` passasse sobre `bg/hover` (Light e Dark) e sobre `bg/elevated` (Dark). Os outros sete (`color/ink/800`, `color/ink/700`, `color/ink/600`, `color/slate/300`, `color/indigo/400`, `color/mist/100`, `color/white`) foram aprovados sem alteração de valor.

Um décimo token entrou nesta correção, fora da lista original: `color/red/400 = #E9675D`, mesma matiz de `color/red/700`, só clareado, usado exclusivamente por `text/danger` no Dark (seção 7). `color/red/700` continua o valor de `action/danger/bg` nos dois temas e de `text/danger` no Light — não foi tocado, porque já passava AA como texto sobre `action/danger/bg` (fundo branco) e sobre `bg/canvas`/`bg/surface` no Light; clareá-lo mais para servir também de texto sobre fundo escuro no Dark teria enfraquecido o contraste de `action/danger/fg` (branco) sobre ele. Por isso o Dark usa um décimo primitive novo só para o texto.

`text/link` no Dark também passou a apontar para `color/indigo/400` (já existente, usado por `focus/ring` no Dark) em vez de `color/indigo/550`, pelo mesmo motivo: `color/indigo/550` já passava AA como fundo sob texto branco (`action/primary/fg`/`action/primary/bg`), e clareá-lo mais teria enfraquecido esse par.

### 5.2 Pauta: dois primitives novos (2026-10-13)

O redesign Pauta (#621) não troca as cores do projeto. Entram só dois primitives, derivados das matizes existentes, e todo o resto vem de `color-mix` sobre a paleta: `color/violet/400 = #A78BFA` (aguardando no escuro, 5,4:1 sobre `ink/800`) e `color/teal/700 = #0F766E` (pronto no claro, 5,5:1 sobre branco). Nenhum HEX fora de `primitives.css`. As escolhas que a folha Identidade do canvas não cobria estão em `docs/business/decisions/2026-10-13-tokens-da-pauta-valores-do-claro-e-degraus-mantidos.md`.

## 6. Semantic tokens — Light

Implementados em [`apps/web/src/styles/tokens/semantic.css`](../apps/web/src/styles/tokens/semantic.css) (`:root`, o tema padrão).

| Token | Aponta para |
|---|---|
| `bg/canvas` | `color/cloud/50` |
| `bg/surface` | `color/white` |
| `bg/elevated` | `color/white` |
| `bg/hover` | `color/mist/100` |
| `text/primary` | `color/ink/900` |
| `text/secondary` | `color/slate/600` |
| `text/muted` | `color/slate/500` |
| `text/link` | `color/indigo/600` |
| `text/danger` | `color/red/700` (mensagem de erro de campo) |
| `border/default` | `color/mist/200` (decorativa; o limite de um controle é `border/control`) |
| `border/subtle` | `color/mist/100` (divisória de baixa ênfase) |
| `border/control` | `color-mix(slate/400 40%, ink/600)` = `#6D7989` |
| `action/primary/bg` | `color/indigo/600` |
| `action/primary/fg` | `color/white` |
| `action/danger/bg` | `color/red/700` (fora da página original — seção 5.1) |
| `action/danger/fg` | `color/white` |
| `focus/ring` | `color/indigo/600` |

**Estado, formato e crachá (Pauta).** Implementados em `semantic.css` (claro) e `themes/dark.css`. `status/{ready,waiting,adjust,late,published,production}/fg` é a cor do **ícone** do estado (não-texto, 3:1); o rótulo fica em `text/secondary`, então o par de texto nunca depende da cor do estado. `calendar/today/bg` é `color-mix(action/primary/bg 14%, bg/surface)`. `format/{carousel,reels,static}/{bg,fg,tag/bg,tag/fg}` tinge o card do calendário por formato (fundo e título) e preenche a etiqueta (`tag/bg` com texto `tag/fg`); o índigo fica fora dos formatos porque é da ação e do hoje. `client-badge/fade/{start,end}` é a base do crachá do cliente (índigo/600 e violeta/600 a 60% sobre `ink/900`), o único degradê da interface (seção 25.3). `shadow/floating` é a única sombra do sistema (seção 11). As regras de uso destas cores estão na seção 25.

`text/muted` está apto para captions, metadata e helper text, inclusive sobre `bg/hover` e `bg/elevated` (seção 20.1, valor de `color/slate/500` ajustado em 2026-09-28 para isso). Conteúdo disabled usa `action/disabled/fg` (sem valor ainda), não `text/muted`.

`text/link` e `text/danger` entraram nesta migração para que link e mensagem de erro deixem de consumir `action/primary/bg` e um primitive direto. Os valores são os que o código já usava e foram aprovados em 2026-09-28. **`text/link` e `text/danger` só têm contraste garantido sobre `bg/canvas` e `bg/surface`** (seção 20.1); não colocar sobre `bg/elevated` nem `bg/hover`.

## 7. Semantic tokens — Dark

Implementados em [`apps/web/src/styles/themes/dark.css`](../apps/web/src/styles/themes/dark.css) (`[data-theme="dark"]`). Dark não é uma inversão automática do Light.

| Token | Aponta para |
|---|---|
| `bg/canvas` | `color/ink/900` |
| `bg/surface` | `color/ink/800` |
| `bg/elevated` | `color/ink/700` |
| `bg/hover` | `color/ink/700` |
| `text/primary` | `color/cloud/50` |
| `text/secondary` | `color/slate/300` |
| `text/muted` | `color/slate/400` |
| `text/link` | `color/indigo/400` (mesmo primitive do `focus/ring` — seção 20.1) |
| `text/danger` | `color/red/400` (primitive próprio, distinto de `action/danger/bg` — seção 20.1) |
| `border/default` | `color/ink/600` (decorativa) |
| `border/subtle` | `color/ink/700` (divisória de baixa ênfase) |
| `border/control` | `color-mix(slate/400 40%, ink/600)` = `#6D7989` (o mesmo valor do Light) |
| `action/primary/bg` | `color/indigo/550` |
| `action/primary/fg` | `color/white` |
| `action/danger/bg` | `color/red/700` (mesmo valor do Light; ver seção 20.1) |
| `action/danger/fg` | `color/white` |
| `focus/ring` | `color/indigo/400` |

`color/indigo/550 = #5B5FE8` foi escolhido, na página original, para manter contraste suficiente tanto com texto branco quanto contra a superfície escura. Por isso `text/link` no Dark não usa `color/indigo/550`: clareá-lo mais, para passar como texto sobre `bg/surface`, teria enfraquecido o contraste de `action/primary/fg` (branco) sobre ele. `text/link` usa `color/indigo/400`, o mesmo primitive já usado por `focus/ring`. A mesma lógica vale para `text/danger`: `color/red/700` já está no limite certo para servir de fundo sob texto branco (`action/danger/fg`), então `text/danger` no Dark usa um primitive próprio, `color/red/400`, mesma matiz clareada.

O app define `[data-theme="dark"]` em `<html>` em toda rota `/agencia/...` (`DarkArea`, `apps/web/src/area-theme.tsx`) e o tira ao sair. Portal, entrada e páginas públicas ficam no claro. Não há seletor de tema: a área decide (decisão `2026-10-14-agencia-sempre-escura-portal-e-entrada-sempre-claros`).

## 8. Spacing

Implementado em [`apps/web/src/styles/tokens/primitives.css`](../apps/web/src/styles/tokens/primitives.css). Escala de 4px:

| Token | Valor |
|---|---|
| `space/1` | 4px |
| `space/2` | 8px |
| `space/3` | 12px |
| `space/4` | 16px |
| `space/6` | 24px |
| `space/8` | 32px |
| `space/12` | 48px |
| `space/16` | 64px |

Evitar valores arbitrários como 13px, 19px ou 27px sem justificativa.

## 9. Radius

Implementado em [`apps/web/src/styles/tokens/primitives.css`](../apps/web/src/styles/tokens/primitives.css).

```
radius/sm   = 6px
radius/md   = 10px
radius/lg   = 14px
radius/xl   = 20px
radius/full = 9999px
```

Uso (Pauta): `sm` etiqueta (`FormatTag`, `StatusTag`, `LateBadge`) e controle de filtro; `md` botão, campo e item da navegação; `lg` painel, card e cartão flutuante; `xl` modal; nas telas refeitas, `full` só avatar (e seu esqueleto), pílula (`Pill`, `PillAction`) e o indicador de carregando. O CSS ainda usa `full` em selos e marcas de telas não refeitas (`.clients__badge`, `.client-detail__status`, `.conversation__status`, `.portal-post__status`, `.content-card__badge`, `.content-folder__badge`, `.content-day__script`, `.content-feed__planned`, `.ui-choice-card__badge`) e na amostra de cor (`.brand-colors__swatch`, o hex é dado da agência); cada uma muda quando a tela for refeita. O `Realce` é a única forma fora da escala: seus cantos desiguais imitam a caneta marca-texto (seção 25.2).

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

Degraus mantidos até cada tela ser refeita (apontam para a escala nova e saem quando ninguém mais os usa): `heading/md` = `heading/lg`, `label/sm` = `caption`, `body/lg` Geist 16/24 400, `label/md` Geist 14/21 500, `button/md` Geist 14/21 600. Tela nova e tela refeita usam só os seis degraus da tabela; `button/md` é do texto de botão, aba e pílula de ação, e fica dentro dos componentes de `packages/ui`.

Regras: no máximo três tamanhos por tela; título com mais espaço acima que abaixo; corpo até 70 caracteres por linha; tracking nunca abaixo de -0,02em (hoje nenhum degrau define `letter-spacing`). Números são tabulares (`font-variant-numeric: tabular-nums` na raiz), mas o shorthand `font` reseta essa propriedade: a regra que aplica um degrau e mostra número a repete (`Pill`, `FormatTag`, `StatusTag` e `LateBadge` já o fazem).

## 11. Shadows / elevation

Implementado em `semantic.css` como `shadow/floating = 0 24px 48px -12px rgb(0 0 0 / .55), 0 2px 6px rgb(0 0 0 / .35)`, a mesma nos dois temas. **Sombra só no que flutua**: ela é o único token de sombra do sistema e hoje só o `Dialog` e o `Popover` a usam. O resto se separa por luminosidade e borda, em quatro níveis:

| Nível | Escuro | Claro | Separação |
|---|---|---|---|
| 0 · canvas | `bg/canvas` `ink/900` | `cloud/50` | o fundo da tela e a navegação lateral |
| 1 · superfície | `bg/surface` `ink/800` | `white` | painel, card e campo, com a borda `border/default` quando precisa de limite |
| 2 · elevado | `bg/elevated` `ink/700` | `white` | o que fica sobre a superfície; o hover usa `bg/hover` (`ink/700` no escuro, `mist/100` no claro) |
| 3 · flutuante | `bg/elevated` + `shadow/floating` | idem | o `Popover` (o cartão do hover) |

O `Dialog` e o `ConfirmDialog` ficam em `bg/surface`, não no nível 3: o `Dialog` leva a borda `border/default` e a sombra, o `ConfirmDialog` a borda de dano e nenhuma sombra. O menu (`.ui-menu__content`) também é `bg/surface`, com borda e sem sombra. Só o `Popover` usa `bg/elevated`.

A borda do nível 1 no escuro é `border/default` = `ink/600`. A folha Identidade do canvas desenha `ink/700`, mas o CSS não a mudou e vale o CSS: `ink/700` é `border/subtle`, a divisória de baixa ênfase (entre filtros, abas, navegação lateral e barra inferior). As duas são **decorativas**: separam, mas não são o limite de um controle (esse é `border/control`, seção 13 e 20.1). `shadow/none`, `sm`, `md` e `lg` continuam conceituais, sem valor; não criar sombra de card, de botão nem de painel.

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

Há **um gesto autoral**: o `Realce` entra varrendo da esquerda quando algo vira a vez de quem olha ou é aprovado. O resto é instantâneo ou só de cor. Arrastar um card no calendário não leva transição: o card segue o cursor, sem atraso. `prefers-reduced-motion: reduce` desliga a entrada do modal e do cartão, a varredura do realce, as transições dos controles e o giro do filtro ocupado. Os demais indicadores de carregando (botão, pílula e campo) continuam girando, porque avisam que há trabalho em curso. `motion/easing/exit` segue sem valor: fica pendente até um componente precisar dele. Motion explica mudança de estado, expansão, drag-and-drop ou contexto; nunca atrasa uma ação operacional.

## 13. Estratégia de componentes — shadcn + Ageniza

Este projeto **não usa shadcn/ui nem Tailwind hoje**. O dono do produto decidiu em 2026-09-28 (ver [`business/decisions/2026-09-28-o-repositorio-e-a-fonte-do-design-system-com-documento-e.md`](business/decisions/2026-09-28-o-repositorio-e-a-fonte-do-design-system-com-documento-e.md)) que a parte B adota shadcn/ui, copiado para o repositório como base de mecânica e acessibilidade, com as variáveis do shadcn como ponte para os tokens Ageniza (seção 15). Até a parte B entrar, a mecânica é própria (HTML nativo, `<dialog>`, rádio, `aria-*`) e os tokens são os da Ageniza:

- Ageniza define tokens, aparência, semântica e API pública;
- construir no Figma, quando existir, só os componentes que uma tela real exigir;
- promover/adaptar componentes conforme a UI divergir do padrão original.

> shadcn define a mecânica do primitive; Ageniza define semântica, aparência e API pública.

Todos os componentes abaixo moram em [`packages/ui`](../packages/ui/src/index.tsx), usam só tokens e têm uma entrada no registro da página `/design-system` (seção 24). **Antes de criar um componente, confira esta lista**: uma tela que monta um botão, uma etiqueta ou um vazio à mão está quebrando a seção 14. O ícone é sempre de `lucide-react`, o único conjunto do app: 20 px na interface e 16 px dentro de pílula, aba e etiqueta (12 px), traço 1,75. Ele fica fora da árvore de acessibilidade (`aria-hidden`), então o rótulo continua sendo o nome do controle.

### 13.1 Ação

| Precisa de | Use | Regra |
|---|---|---|
| A ação principal da tela | `Button` `variant="primary"` | Uma por tela, em índigo cheio. |
| Uma ação ao lado da principal | `Button` `secondary` (com borda) ou `ghost` (só texto) | Secundária com borda, terciária só texto. |
| Apagar, arquivar, encerrar | `Button` `destructive` | Dano real, depois de confirmação (`ConfirmDialog`). |
| Ação só com ícone | `IconButton` | Exige `label`, que vira `aria-label` e dica de passar o mouse. |
| Ir para outra tela com cara de botão | `ButtonLink` | Um `<a>` de verdade, ou o componente de `as` (`as={Link} to="/clientes"`); nunca a string de classes copiada. Desativado, vira um `span` com `aria-disabled`, sem endereço e fora da ordem de tabulação. |
| Um contador ou rótulo curto | `Pill` | Estático; `tone="accent"` só nos usos do realce (seção 25.2). |
| A próxima ação de um card | `PillAction` | Em cápsula, com os estados do `Button`. |

`Button` aceita `variant` (`primary`, `secondary`, `ghost`, `destructive`), `size` (`sm` 32 px, `md` 44 px, `lg` 52 px de altura), `leadingIcon`, `trailingIcon` e `loading`. O `variant` `outline` do shadcn corresponde ao nosso `secondary`; não expor `outline` como API pública da aplicação. Evitar cópias soltas como `Button Blue`, `Button New`, `Button Final 2`.

**Duas adaptações provisórias** no `Button`, até existirem os tokens que o vocabulário prevê: o hover de `primary` e `destructive` usa `filter: brightness(0.94)` no lugar de `action/primary/hover` e `action/danger/hover`, e o estado disabled usa `opacity: 0.55` no lugar de `action/disabled/fg`. No loading, o botão fica com `aria-busy` e `aria-disabled` (nunca `disabled` nativo, que tira o foco do teclado de quem acabou de acioná-lo), o clique não faz nada, e o rótulo fica transparente sem sair da árvore de acessibilidade, para o spinner aparecer na cor do variant. `PillAction` e `Segmented` seguem a mesma regra.

### 13.2 Dado e filtro

| Precisa de | Use | Regra |
|---|---|---|
| Texto numa linha, texto longo, escolha numa lista | `TextInput`, `Textarea`, `Select` | Passthrough nativo (classes `ui-text-input`, `ui-textarea` e `ui-select`), com foco visível pela regra global de `:focus-visible`. |
| Rótulo, dica, contador e erro de um campo | `Field` | Entrega ao controle `id`, `aria-describedby` (dica, contador e erro, nessa ordem), `aria-invalid` e `aria-busy` por `{(control) => <TextInput {...control} />}`; o erro leva ícone e texto, e passar do limite do contador também marca o controle como inválido. `Select` já usa `Field` e aceita `hint`, `error` e `loading`. |
| Escolher um item entre poucos, com contexto | `ChoiceCard` | O cartão inteiro é o botão (nome e descrição). |
| Filtros em faixa | `FilterBar` com `FilterBarSelect` ou `FilterBarItem` | O rótulo pequeno em cima, a escolha embaixo, divisórias entre os filtros; no celular os filtros empilham com divisórias horizontais. `FilterBarSelect` é o `select` nativo, plano; `FilterBarItem` recebe qualquer outro controle e entrega `id`, `className` e `aria-busy` por `{(control) => …}`. |
| Várias páginas de resultado | `Pagination` | Até sete páginas aparecem todas; acima disso, as pontas ficam fixas e uma janela acompanha a atual. |

**Borda de controle.** A borda de `input`, `select`, `textarea`, `ChoiceCard` e do `TextInput` dentro de uma `FilterBar` é o limite de um componente de interface e precisa de 3:1 sobre a superfície (WCAG 1.4.11): usa `border/control` (`#6D7989`, o mesmo valor nos dois temas). As demais bordas são **decorativas** e ficam em `border/default` ou `border/subtle`: separam, não delimitam um controle. Os números estão na seção 20.1. Sobre `bg/elevated` e `bg/hover` o token passa no claro (4,42:1 e 4,09:1) e **não passa no escuro** (2,33:1): campo sobre superfície elevada no escuro continua sendo ponto em aberto. Hover e estado inválido de um campo mudam só a cor da borda, para o 3:1 nunca se perder.

### 13.3 Navegação e escolha de visão

| Precisa de | Use | Regra |
|---|---|---|
| Alternar entre duas ou três visões da mesma coisa (Grade e Lista) | `Segmented` | Grupo de rádio, uma parada de tabulação e setas. A opção escolhida leva borda e superfície, não só cor. |
| Dividir uma tela em seções | `Tabs` | Ativação automática: setas movem e abrem, Home e End vão às pontas, aba desabilitada é pulada. A aba aberta se sublinha em tinta, nunca em índigo. `keepMounted` numa aba mantém o painel dela montado e oculto enquanto outra está aberta, para o que foi digitado sobreviver à visita (o formulário do modal do conteúdo). |
| Escolher o cliente em que se trabalha | `ClientStrip` | Os clientes como stories, em `<nav>` com um link de verdade por cliente (`href` obrigatório). O aberto leva `aria-current="page"`, uma superfície e o `Realce` no nome. `renderLink` deixa a tela desenhar o link com o roteador. |
| Ações de um item (os três pontos) | `Menu`, `MenuItem`, `MenuSeparator` | Menu de botão: setas, Home e End movem, Esc fecha; o foco volta ao gatilho. |

O shell da agência (`AgencySidebar`, em `apps/web/src/agency-nav.tsx`) é código do app, não de `packages/ui`: navegação lateral com grupos Trabalho e Agência, o logo no topo, a pessoa e Sair no pé (seção 19).

**Crachá do cliente (#636).** A carteira é uma grade de crachás (3 colunas a partir de 80 rem, 2 a partir de 48 rem, 1 abaixo), só com tokens e os componentes acima, sem componente novo em `packages/ui`. O topo do crachá é o `Avatar` grande (foto ou iniciais) sobre `bg/elevated`, com a base em `client-badge/fade/{start,end}`: nome em branco e @ em `color/slate/300` (6,4:1 ou mais sobre as duas pontas), sem brilho nem vidro. O selo de triagem é um só, na ordem atrasado (`LateBadge`), prazo em até 2 dias e convite pendente (`Pill` com ícone); o que não virou selo continua como etiqueta no corpo. Os três números de conteúdo ficam sobre `bg/canvas`, onde `text/muted` e `text/danger` estão garantidos, e a próxima ação é um `PillAction` neutro (o índigo cheio fica com a ação da página, `Cadastrar cliente`). O link do crachá leva a foto, o nome e as etiquetas e tem o nome do cliente como nome acessível; o menu de três pontos e a ação são botões ao lado dele, nunca dentro. O crachá não leva `overflow: hidden`, porque o menu abre por cima dele. A tela usa 48 (título), 22 ("Seus clientes" e nome) e 14 px, e o 12 px só dos componentes (rótulo do filtro, `Pill`) e dos rótulos dos números.

### 13.4 Camadas

| Precisa de | Use | Regra |
|---|---|---|
| Uma tarefa que exige interrupção e foco protegido | `Dialog` (`Modal` é o mesmo componente, para as telas que ainda não migraram) | Sobre o `<dialog>` nativo: título, `description` opcional, `actions` no pé (a ação primária por último), `size` `sm`, `md` ou `lg` (28, 40 e 52 rem), raio `xl`, `shadow/floating` e entrada de 180 ms. Uma tarefa que não precisa de interrupção não é modal. |
| Confirmar uma ação destrutiva | `ConfirmDialog` | Confirmação de tela cheia sobre `bg/canvas`, com borda de dano; o foco começa em cancelar, Esc cancela e a ação destrutiva aceita `busy`. |
| Um cartão ancorado ao gatilho (o hover do calendário) | `Popover` | Abre ao clique ou, com `openOn="hover"`, depois de 300 ms com o mouse parado ou na hora no foco do teclado, nunca no toque; só fecha 150 ms depois de o mouse sair (`hoverLeaveDelay`), tempo de atravessar o vão de 8 px até o cartão sem que ele suma (WCAG 1.4.13); Esc e um clique fora fecham e devolvem o foco ao gatilho. Não troca de lado na borda da tela: quem usa escolhe o `placement` com espaço. |

O `Popover` fica na superfície elevada, onde `text/link`, `text/danger` e a borda de controle não estão garantidos no escuro (seção 20.1): leva texto e ações, não campos. O mesmo vale para qualquer cartão sobre `bg/elevated` ou `bg/hover`. Quem pôr link ou erro ali confere o contraste e usa a variante derivada da paleta. O `Dialog` e o `ConfirmDialog` ficam em `bg/surface`, onde link, erro e campo passam (20.1): levam campo. Nenhum export de `packages/ui` leva o nome de um global do JS (item 69 do checklist).

### 13.5 Conteúdo e estado

As etiquetas são estáticas (sem hover, foco nem carregamento): o texto é quem diz, a cor só ajuda.

| Precisa de | Use | Regra |
|---|---|---|
| O formato de um conteúdo | `FormatTag` (`carousel`, `reels`, `static`) | Etiqueta preenchida, par `format/*/tag/{bg,fg}`; o chamador mapeia o formato dele para um desses três. |
| O estado de um conteúdo | `StatusTag` (`ready`, `waiting`, `adjust`, `published`, `production`) | Contorno com o ícone `lucide` do estado e o rótulo; a cor `status/*/fg` vai só no ícone (12 px, 3:1) e o rótulo fica em `text/secondary`. |
| Atrasado | `LateBadge` ("Atrasado") | O único estado em bloco cheio, no par `action/danger`. |
| Uma pessoa ou um cliente | `Avatar` | Foto ou iniciais, nunca um ícone genérico. `attention` é o motivo em palavras ("em ajuste, em atraso"): desenha o anel (2 px de vão na cor do fundo, depois 2 px em `status/late/fg`) e o diz para a tecnologia assistiva, então o anel nunca é o único sinal. `--ui-avatar-gap` troca a cor do vão quando o fundo não é o canvas. |
| A pessoa da equipe | `BadgeCard` | Exatamente quatro informações: foto ou iniciais, nome, cargo e papel (mais o marcador de removido); um quinto dado vira tabela, o que a SPEC de colaboradores recusa. |
| A palavra que pede decisão agora | `Realce` | Seção 25.2. |

**Pastas de mídia (#634).** A visão Pastas do cliente é só composição, sem componente novo em `packages/ui`: o caminho (`ChevronRight` entre os níveis), a pasta como link com `Folder`, o nome e a `Pill` "Padrão", a mídia em cartão com a miniatura (`bg/hover`, com `Image` ou `Video` no lugar enquanto não há imagem), o rótulo com ícone e, quando o vídeo não está pronto, a `Pill` "Processando vídeo" ou o aviso "Falha no processamento do vídeo" em `text/danger`. Nenhum botão da visão é índigo cheio (a ação primária é a da página). O envio é um `Button` secundário "Enviar mídia" que abre o seletor nativo, escondido da tela e do leitor de tela; o arquivo escolhido fica numa linha com ícone, nome e tamanho, a barra de progresso é neutra (tinta, nunca índigo) com o número em tabular, e o erro leva ícone, texto e "Tentar de novo" quando repetir ajuda (arquivo recusado pede outro arquivo, não o mesmo). Pasta e mídia vazias usam o `EmptyState` compacto e sem mascote, com o botão que resolve; erro de carga leva ícone, texto e "Tentar de novo". No celular a mídia vira linha (miniatura de 5 rem ao lado) com alvos de 44 px, e as grades usam `grid-template-columns` com `minmax(0, 1fr)` ou `repeat(auto-fill, minmax(min(100%, 14rem), 1fr))`, para nenhum filho passar do cartão. A tela usa 22 (títulos), 14 e 12 px.

### 13.6 Vazio, erro e carga

| Precisa de | Use | Regra |
|---|---|---|
| Lista sem nada ainda | `EmptyState` (`title`, `description`, `action`, `mascot` opcional) | Diz o que falta, por quê e o caminho. A primeira visita com ação leva a coruja amigável; busca sem resultado é só texto e "Limpar filtros", sem coruja. |
| A coruja | `Mascot` (`friendly` ou `serious`) | O único jeito de pôr a coruja numa tela: `<img>` WebP com `srcset` 1x/2x, largura e altura da pose e `alt=""`, porque o título ao lado já diz tudo. Uma por tela e nunca numa tela de trabalho cheia (docs/brand.md). |
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
│   └── semantic.css     # bg/text/border/action/focus — valores do Light (tema padrão)
├── themes/
│   ├── light.css        # comentário só: Light já está em tokens/semantic.css
│   └── dark.css         # `[data-theme="dark"]`, sobrescreve os semantic tokens
└── globals.css           # importa tudo acima; reset; classes de componente
```

**Duas adaptações em relação à página original**, registradas aqui para quem for mexer na estrutura depois:

1. A página original juntava cor, espaço, radius, fonte e motion num único bloco `:root` "Primitives" (seção 16). Este repositório separa fonte em `typography.css` e motion em `motion.css`, seguindo a própria árvore de pastas que a página descrevia (seção 15 dela), que já previa os quatro arquivos.
2. A página original dava Light e Dark como dois blocos CSS completos e paralelos (`:root, [data-theme="light"] {...}` e `[data-theme="dark"] {...}`). Como Light é o tema padrão, seus valores ficam em `tokens/semantic.css` no `:root`; `themes/light.css` existe só para simetria de pasta com `themes/dark.css` e não duplica os valores.

`apps/web/src/main.tsx` importa só `./styles/globals.css`; os outros arquivos entram por `@import` dentro dele, na ordem: primitives → typography → motion → semantic → themes/light → themes/dark.

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

**Exceção conhecida:** o cabeçalho de `.app-shell` usa `color/ink/900` e `color/white` direto, e fica escuro nos dois temas. É o visual herdado da folha de estilo anterior aos tokens, e não há semantic token para uma faixa escura fixa; fica assim até o refino do designer definir o cabeçalho.

## 18. Design tokens no repositório — evolução recomendada

Quando houver necessidade de automação, evoluir para um diretório `design-tokens/` com `color.json`, `spacing.json`, `radius.json`, `typography.json`, `semantic-light.json` e `semantic-dark.json`, idealmente em formato compatível com DTCG, permitindo gerar depois CSS variables, tema Tailwind, documentação e eventual sincronização com Figma. Para o MVP, não adicionar pipeline de tokens se isso atrasar produto — a arquitetura atual (arquivos CSS simples, um por camada) não bloqueia essa evolução.

## 19. Grid e responsividade

Desktop-first para operação, com o celular funcional: a navegação da agência vira barra inferior, os filtros empilham, o modal vira coluna. O portal do cliente é celular primeiro (ver `specs/clientes.md`), a exceção deliberada a essa direção, não uma contradição: cada produto (operação vs. portal) tem sua prioridade de breakpoint. O portal fica fora da Pauta até o dono decidir sobre ele.

**Shell da agência** (`.agency-shell` em `globals.css`, `AgencySidebar` em `apps/web/src/agency-nav.tsx`):

| Largura | Navegação | Conteúdo |
|---|---|---|
| a partir de 48 rem | lateral fixa à esquerda, aberta com 248 px (15,5 rem) ou recolhida no trilho de 80 px (5 rem) | até 80 rem, com `space/8` nas laterais |
| abaixo de 48 rem | barra inferior fixa, com a área segura do aparelho (`env(safe-area-inset-bottom)`); cada grupo ocupa a barra em proporção aos itens | `space/4` nas laterais e folga embaixo para a barra |

A navegação abre **recolhida** no calendário de um cliente (a rota `/agencia/:agenciaId/conteudos/:clienteId`), onde o mês precisa da largura, e **aberta** nas demais telas; a escolha explícita da pessoa vale até recarregar a página. Aberta, mostra o logo, o contexto ativo, os grupos (Trabalho: Início, Conteúdos, Clientes; Agência: Equipe) e a pessoa com Sair no pé; recolhida, o símbolo chapado e os ícones com o rótulo embaixo; na barra inferior, só os ícones com o rótulo (`label/sm`), sem o logo, o contexto e o Sair solto.

**Breakpoints.** Uma media query não lê custom property, então os valores moram no CSS, em `rem`, e são três: `40rem` (celular largo: filtros e vazio empilham), `48rem` (a navegação vira lateral a partir dele e barra inferior abaixo, com `max-width: 47.99rem` como o complemento; o modal do conteúdo vira coluna com `max-width: 48rem`, então em exatos 48 rem já está em coluna e a navegação já é lateral) e `64rem` (um painel ao lado do principal: o feed junto ao calendário e a semana de exemplo das telas de entrada, que abaixo disso ficam em uma coluna só). `40.0625rem` não é um quarto valor: é o complemento de `40rem` (como `47.99rem` é o de `48rem`), usado quando uma regra vale só acima do ponto em que a `FilterBar` empilha, para que em exatos 40 rem as duas não se sobreponham. Uma grade de cards não ganha breakpoint: usa `repeat(auto-fill, minmax(min(100%, <largura do card>), 1fr))` e as colunas seguem o espaço que a navegação deixa (a carteira de clientes, com cards de `20rem`, tem uma coluna a 768 px com a navegação aberta e três a 1440 px). Uma tela nova reaproveita esses três; um quarto valor por tela é divergência a discutir, não a decidir localmente.

**Alvo de toque.** O botão `md` tem 44 px de altura e o `lg`, 52 px; o `sm` (32 px) é para linha densa de desktop. No celular, prefira `md` ou maior para o que se toca (é o "área clicável suficiente" da seção 20). Abas e itens de navegação já têm no mínimo 44 px.

**Tela redesenhada, medida no celular.** Em 390 px de viewport emulado (nunca a janela do navegador, que não encolhe tanto), todo controle da versão anterior tem de continuar alcançável: compare `scrollWidth` e os elementos fora da tela com o `develop`. Um painel com `overflow: hidden` ao redor de conteúdo largo esconde controles no celular sem nenhum teste falhar (#657). Quando precisa rolar, o contêiner rola (`overflow-x: auto`) e o anel de foco dos itens fica por dentro.

## 20. Acessibilidade como foundation

Antes de aprovar um componente: contraste adequado; foco visível; estado disabled identificável; área clicável suficiente; label acessível; estado não comunicado só por cor; navegação por teclado quando aplicável. Na Pauta, isso quer dizer, concretamente:

- **Foco.** `:focus-visible` desenha 3 px sólidos em `focus/ring`, a 3 px de distância. Dentro de um contêiner que rola (`Tabs`, `ClientStrip`) o anel vai por dentro (`outline-offset: -3px`), porque um anel por fora seria cortado; o `Segmented` usa 0. `focus/ring` tem 3:1 sobre `bg/canvas`, `bg/surface` e `bg/hover` nos dois temas (20.1).
- **Estado nunca só por cor.** Estado de conteúdo vai com ícone e rótulo (`StatusTag`); o anel do `Avatar` vai com o motivo em palavras no nome do link; o cliente aberto leva `aria-current` e superfície além do `Realce`; a opção escolhida do `Segmented` leva borda e superfície.
- **Carregando** é `aria-busy` com `aria-disabled` e uma guarda no clique, nunca `disabled` nativo, que tira o foco de quem acabou de acionar o controle (item 70 do checklist). O filtro e o campo continuam usáveis e dizem que estão ocupados.
- **Nome acessível contém o texto visível** do controle: o rótulo do botão, a dica de um `IconButton` e o motivo do anel de atenção depois do nome do cliente.
- **Movimento reduzido** (`prefers-reduced-motion: reduce`) desliga as transições dos controles, a entrada de modal e cartão e a varredura do `Realce` (seção 12).
- **Superfície elevada.** `text/link`, `text/danger` e `border/control` não têm contraste garantido no escuro sobre `bg/elevated` e `bg/hover`: nada disso entra em `Popover` ou cartão do hover sem conferir o par antes (20.1). O `Dialog`, o `ConfirmDialog` e o menu ficam em `bg/surface`, onde os três passam.

### 20.1 Contraste — tabela final, aprovada em 2026-09-28

Pares de texto sobre fundo em Light e Dark, contra WCAG AA (4.5:1 para texto normal, 3:1 para texto grande e componentes de UI), recalculados com os valores finais do CSS (fórmula de luminância relativa do WCAG 2.x, mistura do `color-mix` em sRGB). **Todos os pares em uso passam.** A primeira rodada (2026-09-28) corrigiu as quatro falhas que a migração inicial havia deixado (ver histórico abaixo), ajustando a luminosidade de dois primitives e introduzindo dois primitives novos, sem mudar a matiz de nenhum; a Pauta (#621) acrescentou os pares das tabelas seguintes, sem cor nova além de `violet/400` e `teal/700`. O teste `apps/web/src/styles/tokens.test.ts` lê as tabelas desta seção e reprova quando uma razão citada diverge do que as folhas de estilo calculam: mudou um token, a tabela muda no mesmo PR.

| Par | Light | Dark |
|---|---|---|
| `text/primary` sobre `bg/canvas` | 16.96:1 | 16.96:1 |
| `text/primary` sobre `bg/surface` | 17.74:1 | 14.03:1 |
| `text/primary` sobre `bg/elevated` / `bg/hover` | 17.74:1 / 16.40:1 | 9.85:1 / 9.85:1 |
| `text/secondary` sobre `bg/canvas` / `bg/surface` | 7.24:1 / 7.58:1 | 11.95:1 / 9.89:1 |
| `text/secondary` sobre `bg/elevated` / `bg/hover` | 7.58:1 / 7.00:1 | 6.94:1 / 6.94:1 |
| `text/muted` sobre `bg/canvas` / `bg/surface` | 4.81:1 / 5.03:1 | 7.96:1 / 6.58:1 |
| `text/muted` sobre `bg/elevated` | 5.03:1 | 4.62:1 |
| `text/muted` sobre `bg/hover` | 4.65:1 | 4.62:1 |
| `text/link` sobre `bg/canvas` / `bg/surface` | 6.01:1 / 6.29:1 | 5.95:1 / 4.92:1 |
| `text/danger` sobre `bg/canvas` / `bg/surface` | 6.28:1 / 6.57:1 | 5.54:1 / 4.59:1 |
| `action/primary/fg` sobre `action/primary/bg` | 6.29:1 | 4.94:1 |
| `action/danger/fg` sobre `action/danger/bg` | 6.57:1 | 6.57:1 |

Os pares de `action/primary` valem para o `Button`, a `Pill` e a `PillAction` de `tone="accent"` e o `Realce`; os de `action/danger`, para o `Button` destrutivo e o `LateBadge`.

**Não-texto (3:1), claro / escuro.** Limites de controle, anel de foco e anel de atenção do avatar. `border/control` é o limite de `input`, `select`, `textarea`, `ChoiceCard` e do campo de texto da `FilterBar` (WCAG 1.4.11); as bordas decorativas ficam abaixo de 3:1 de propósito, porque não delimitam um controle.

| Par | Light | Dark |
|---|---|---|
| `border/control` sobre `bg/canvas` / `bg/surface` | 4.23:1 / 4.42:1 | 4.01:1 / 3.32:1 |
| `border/control` sobre `bg/elevated` / `bg/hover` | 4.42:1 / 4.09:1 | **2.33:1 / 2.33:1** (restrição) |
| `focus/ring` sobre `bg/canvas` / `bg/surface` / `bg/hover` | 6.01:1 / 6.29:1 / 5.81:1 | 5.95:1 / 4.92:1 / 3.46:1 |
| Anel de atenção do avatar (`status/late/fg`) sobre `bg/canvas` / `bg/surface` / `bg/hover` | 6.28:1 / 6.57:1 / 6.08:1 | 5.54:1 / 4.59:1 / 3.22:1 |
| `border/default` sobre `bg/canvas` / `bg/surface` (decorativa) | 1.13:1 / 1.18:1 | 2.35:1 / 1.94:1 |
| `border/subtle` sobre `bg/canvas` / `bg/surface` (decorativa) | 1.03:1 / 1.08:1 | 1.72:1 / 1.42:1 |

O anel do avatar sobre `bg/hover` é o do item aberto ou sob o mouse no `ClientStrip` (o vão troca para a cor do item por `--ui-avatar-gap`); no escuro é o par mais apertado desta tabela, e qualquer mudança em `color/red/400` ou `color/ink/700` precisa reconferi-lo.

**Pares da Pauta (#622), claro / escuro**, recalculados pelo teste `apps/web/src/styles/tokens.test.ts` com a mistura em sRGB do `color-mix`. Ícone de estado é não-texto (3:1); título e etiqueta de formato são texto (4,5:1).

| Par | Light | Dark |
|---|---|---|
| `status/ready/fg` sobre `bg/canvas` / `bg/surface` | 5.23:1 / 5.47:1 | 7.13:1 / 5.90:1 |
| `status/waiting/fg` sobre `bg/canvas` / `bg/surface` | 5.45:1 / 5.70:1 | 6.52:1 / 5.39:1 |
| `status/adjust/fg` sobre `bg/canvas` / `bg/surface` | 6.01:1 / 6.29:1 | 5.95:1 / 4.92:1 |
| `status/late/fg` sobre `bg/canvas` / `bg/surface` | 6.28:1 / 6.57:1 | 5.54:1 / 4.59:1 |
| `status/published/fg` sobre `bg/canvas` / `bg/surface` | 7.24:1 / 7.58:1 | 7.96:1 / 6.58:1 |
| `status/production/fg` sobre `bg/canvas` / `bg/surface` | 4.81:1 / 5.03:1 | 7.96:1 / 6.58:1 |
| `format/carousel/fg` sobre `format/carousel/bg` | 5.00:1 | 6.20:1 |
| `format/reels/fg` sobre `format/reels/bg` | 5.14:1 | 6.04:1 |
| `format/static/fg` sobre `format/static/bg` | 16.40:1 | 8.50:1 |
| `format/carousel/tag/fg` sobre `format/carousel/tag/bg` | 5.47:1 | 7.13:1 |
| `format/reels/tag/fg` sobre `format/reels/tag/bg` | 5.70:1 | 6.52:1 |
| `format/static/tag/fg` sobre `format/static/tag/bg` | 7.58:1 | 11.95:1 |
| `text/secondary` sobre `format/{carousel,reels,static}/bg` | 6.92:1 · 6.83:1 · 7.00:1 | 8.11:1 · 8.13:1 · 8.50:1 |
| `text/primary` sobre `calendar/today/bg` | 14.33:1 | 12.23:1 |
| branco sobre `client-badge/fade/start` / `end` | 9.96:1 / 9.53:1 (o crachá é escuro nos dois temas) | 9.96:1 / 9.53:1 |
| `color/violet/400` sobre `bg/surface` | n/a | 5.39:1 |
| `color/teal/700` sobre `bg/surface` | 5.47:1 | n/a |

O rótulo de um `StatusTag` é `text/secondary` sobre `bg/canvas` ou `bg/surface` (primeira tabela), e o da `Pill` neutra, `text/secondary` sobre `bg/hover`: nenhum par de texto depende da cor do estado.

**Restrição de uso, não falha:** `text/link` e `text/danger` só foram conferidos sobre `bg/canvas` e `bg/surface`, os fundos onde link e mensagem de erro aparecem hoje. Sobre `bg/elevated`/`bg/hover` no Dark eles cairiam a 3.46:1 e 3.22:1, e `border/control` a 2.33:1 — por isso o comentário em `themes/dark.css` e a nota na seção 6 dizem para não os usar ali. Se uma tela real precisar de link, erro ou campo sobre esses fundos (popover, cartão do hover, crachá), isso volta a ser um ponto em aberto: confira o par e use a variante derivada da paleta, não uma aprovação silenciosa.

`text/muted` sobre `bg/hover` no Dark (4.62:1) é o par de texto aprovado mais apertado: qualquer mudança futura em `color/slate/400` ou `color/ink/700` precisa reconferi-lo.

**Histórico — o que a migração inicial (parte A) tinha deixado em aberto e como foi corrigido:**

A primeira rodada de valores propostos falhava em quatro pares: `text/muted` sobre `bg/hover` (Light 4.40:1, Dark 4.02:1) e sobre `bg/elevated` (Dark 4.02:1); `text/link` sobre `bg/canvas`/`bg/surface` no Dark (3.59:1 / 2.97:1); `text/danger` sobre `bg/canvas`/`bg/surface` no Dark (2.70:1 / 2.23:1). O dono do produto aprovou os valores em 2026-09-28 só depois desta correção:

- `color/slate/500` (Light `text/muted`) escureceu de `#64748B` para `#617087` — mesma matiz e saturação, luminosidade menor, resolve `bg/hover`.
- `color/slate/400` (Dark `text/muted`) clareou de `#94A3B8` para `#A1AFC1` — mesma matiz e saturação, luminosidade maior, resolve `bg/elevated`/`bg/hover`.
- `text/link` no Dark passou a apontar para `color/indigo/400` (já existente, do `focus/ring`) em vez de `color/indigo/550`: clarear `color/indigo/550` diretamente teria enfraquecido `action/primary/fg` sobre `action/primary/bg`, que já passava (4.94:1).
- `text/danger` no Dark passou a apontar para um primitive novo, `color/red/400 = #E9675D` (mesma matiz de `color/red/700`, clareada), pelo mesmo motivo: `color/red/700` já estava no ponto certo para `action/danger/fg` sobre `action/danger/bg` (6.57:1 nos dois temas) e para `text/danger` no Light; clareá-lo mais teria enfraquecido esse par. `action/danger/bg` continua `color/red/700` nos dois temas — não foi tocado.

Nenhuma correção mudou a matiz de um token: cada ajuste manteve a família de cor (slate continua slate, indigo continua indigo, red continua red) e mudou só a luminosidade, ou introduziu um primitive irmão na mesma matiz para separar um uso de texto de um uso de fundo que já estava correto.

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
- [ ] funciona em Light e Dark quando o componente exigir;
- [ ] acessibilidade básica validada (seção 20);
- [ ] componente novo foi criado só quando não existia equivalente reutilizável.

Paridade entre Figma e código **não** é critério de aceite aqui: entra no refino de cada tela, depois que ela está no ar, com o designer (ver [`business/decisions/2026-09-28-a-tela-e-implementada-a-partir-do-esboco-e-o-designer.md`](business/decisions/2026-09-28-a-tela-e-implementada-a-partir-do-esboco-e-o-designer.md)).

> A meta não é construir um design system gigantesco antes do produto. A meta é garantir que cada nova tela aumente um sistema consistente, em vez de criar uma nova linguagem visual a cada implementação.

## 24. Página viva `/design-system`

Rota interna, só no servidor de desenvolvimento (`pnpm --filter @ageniza/web dev`, endereço `/design-system`); o build de produção não a contém (ver [`business/decisions/2026-10-14-pagina-design-system-so-no-ambiente-de-desenvolvimento.md`](business/decisions/2026-10-14-pagina-design-system-so-no-ambiente-de-desenvolvimento.md)).

- **Tokens:** cores primitivas, tokens semânticos nos dois temas (com a marca dos que o escuro sobrescreve), tipografia, espaço, raio, elevação e movimento. Tudo é lido dos arquivos de `apps/web/src/styles`: token novo aparece sozinho, sem editar a página.
- **Componentes:** `apps/web/src/design-system/components.tsx` guarda um registro. Componente novo em `packages/ui` exige uma entrada nele (o teste `design-system.test.tsx` reprova quando falta e diz o formato; um export em maiúscula que não é componente entra na lista `NOT_COMPONENTS` do teste, com o motivo), com `covers` listando o que exporta e um exemplo por variante; a página monta as colunas Padrão, Hover, Foco, Desativado e Carregando e marca "—" no estado que o componente não tem.

## 25. Regras da Pauta

A direção **Pauta** (épico #621) desenha a área da agência escura: uma mesa editorial à noite, tudo quieto em grafite, e o índigo é o realce que a editora passa só no que pede uma decisão agora. As cores do projeto não mudam; a distinção vem da tipografia expandida, do realce como gesto único de ação, da disciplina de cor por quem tem a vez e das capas dos posts, que carregam a cor da tela (a interface não compete com o trabalho da agência). Estas regras valem em toda tela da área da agência, **somadas** à Definition of Done da seção 23; o portal do cliente fica fora até o dono decidir sobre ele. Estão registradas em [`business/decisions/2026-10-13-pauta-quem-tem-a-vez-decide-a-cor-e-as-quatro-excecoes.md`](business/decisions/2026-10-13-pauta-quem-tem-a-vez-decide-a-cor-e-as-quatro-excecoes.md) e [`business/decisions/2026-10-14-o-realce-tem-quatro-usos-incluindo-o-cliente-selecionado.md`](business/decisions/2026-10-14-o-realce-tem-quatro-usos-incluindo-o-cliente-selecionado.md).

### 25.1 Quem tem a vez decide a cor

A cor de um estado do conteúdo diz de quem é a vez. O que está em dia recua para o cinza; o que está travado salta. A carteira e o calendário são painéis de plantão, não relatórios.

| Estado | Ícone | Claro / escuro | A vez é de quem |
|---|---|---|---|
| Em ajuste | `Pencil` | `indigo/600` / `indigo/400` | da agência: usa a cor da ação |
| Aguardando aprovação | `Clock` | `violet/600` / `violet/400` | do cliente |
| Pronto para publicar | `Check` | `teal/700` / `teal/500` | aprovado, falta publicar |
| Atrasado | `LateBadge` | `action/danger` cheio, texto branco | de ninguém: precisa saltar; o único estado em bloco cheio |
| Publicado | `CheckCheck` | `slate/600` / `slate/400` | de ninguém: feito fica quieto |
| Em produção | `Circle` | `slate/500` / `slate/400` | neutro |

- A cor vai **no ícone** (`status/*/fg`, não-texto, 3:1) e o rótulo fica em `text/secondary`: o par de texto nunca depende da cor do estado, e o estado nunca é só cor.
- Erro é `text/danger` e diz como sair ("Tentar de novo").
- **Dentro do card do calendário** o fundo e o título são tingidos pelo **formato** (`format/{carousel,reels,static}/{bg,fg}`), e o estado vive na etiqueta (`StatusTag`), ao lado da etiqueta preenchida do formato (`FormatTag`). O atrasado passa por cima de tudo, com contorno vermelho no card inteiro, nunca borda lateral (vem com a #631; hoje o CSS só tem o `LateBadge` e `.content-card__badge--overdue`). No canvas, stories, vídeo e VSL não têm tinta: ficam em `bg/elevated`, com etiqueta de contorno.
- O índigo fica fora dos formatos de propósito: é da ação e do hoje. Reels e aguardando dividem o violeta, e carrossel e pronto dividem o teal; o ícone e o rótulo desfazem a dúvida.

### 25.2 O realce: quatro usos

O índigo cheio (`action/primary/bg`, no `Button` primário, na `Pill` e `PillAction` de `tone="accent"` e no `Realce`) tem **quatro usos e só eles**:

1. **a ação primária da tela**, uma só;
2. **o hoje** (a célula do dia de hoje no calendário, `calendar/today/bg`);
3. **a vez de quem olha** ("2 posts esperando você"), no `Realce` atrás da palavra que pede a decisão;
4. **o cliente selecionado** no `ClientStrip` (decisão do dono de 2026-10-14: no tema claro, só a superfície dá 1,03:1 e o selecionado some).

Duas manchas de índigo cheio competindo na mesma tela, fora destes usos, é erro. Não são índigo cheio, e portanto não entram na regra: o ícone do estado em ajuste, o link (`text/link`) e o anel de foco. A aba aberta se sublinha em tinta, nunca em índigo. O `Realce` tem cantos desiguais, como caneta marca-texto, e é a única forma fora da escala de raios; ele entra varrendo da esquerda (`sweep`, 240 ms) quando algo vira a vez de quem olha ou é aprovado, e fica parado quando a pessoa pede menos movimento.

### 25.3 Exceções aprovadas pelo dono

A lista anti-slop abaixo tem quatro exceções, aprovadas com o canvas v2 (2026-10-13):

1. **Degradê só na base do crachá do cliente.** A foto do crachá termina num degradê de índigo e violeta escurecidos sobre `ink/900` (`client-badge/fade/{start,end}`), com branco por cima a 9,5:1 ou mais (9,96:1 e 9,53:1). Sem glow, sem vidro, sem blur. O degradê do símbolo da marca é do arquivo da marca e não vira estilo de interface.
2. **Cor do card por formato e estado na etiqueta** (25.1), em vez de a cor do card dizer o estado.
3. **Pílula (raio cheio) na ação do crachá e nos contadores.** O raio cheio, antes só do avatar, vale também para `Pill` e `PillAction` (seção 9).
4. **Navegação larga com grupos como shell** de toda a agência: aberta com 248 px, recolhível no trilho de 80 px e, no celular, barra inferior (seções 13.3 e 19).

### 25.4 Anti-slop: o que o revisor recusa em toda tela

- **Nenhum gradiente** em texto, botão ou fundo de página (a exceção é a 1 de 25.3). Nada de vidro, glow ou blur decorativo; sombra só no que flutua (seção 11).
- **Nenhum rótulo acima do título** (eyebrow) nem numeração 01/02/03.
- **Nenhuma borda colorida lateral** em card, linha ou alerta.
- **Nenhum card dentro de card.** Agrupar por espaço e linha divisória.
- **Nenhum número-herói** (número gigante, rótulo e variação) sem a ação que ele pede.
- **Índigo cheio só nos quatro usos** de 25.2.
- **Nenhum estado vazio mudo.** Sempre o que falta e um botão que resolve; erro com "Tentar de novo"; skeleton na primeira carga.
- **Nenhuma cópia genérica** ("Bem-vindo de volta!", "Explore"). O botão diz o que faz; o erro diz o que houve e como sair.
- **Nenhum ícone genérico de pessoa** no lugar de foto: iniciais. Nenhum emoji nem caractere no lugar de ícone: `lucide-react`, em um traço só.
- **Nenhum padrão do navegador esquecido:** seleção de texto, foco, barra de rolagem e cursor de texto na paleta. Hoje o app só define `accent-color`; o foco é global (seção 20), e seleção, barra de rolagem e cursor entram nas telas da Pauta, com a varredura final (#639) conferindo.
- **Modal só quando a tarefa exige interrupção** e foco protegido (seção 13.4).

Mais as regras de tela da issue do épico: uma única ação primária; no máximo três tamanhos de texto por tela; só tokens de `apps/web/src/styles` (nenhum HEX novo além de `violet/400` e `teal/700`); capturas em 1440 e 390 (viewport emulado) ao lado da artboard do canvas.
