# Design system

Como a identidade visual da Ageniza vira um sistema de UI consistente entre design e código. O objetivo é impedir que telas criem cor, espaçamento, tipografia e componente de forma independente.

**O repositório é a fonte de verdade — confirmado pelo dono do produto em 2026-09-28.** Até então este conteúdo vivia numa página do Notion, ["UI System — Figma, Design Tokens & CSS"](https://app.notion.com/p/3d886d2ba8b08172a3fbcc31e1548c31) (histórico — não usar como referência de trabalho); a página vira registro histórico, e a fonte passa a ser aqui, com uma página em `/design-system` no próprio app mostrando os tokens e componentes ao vivo (parte B, em preparo, PR separado — não é pré-requisito para as telas: ver seção 23 e a entrada de 2026-09-28 em `decisions.md`). Ver a entrada de 2026-09-28 "O repositório é a fonte do design system, com documento e página viva" em [`decisions.md`](business/decisions.md), que registra as decisões fechadas nesta data. O Notion permanece como registro histórico da decisão original, nunca mais como referência para implementar.

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

Esses tokens apontam para `Primitives`. Não manter um único `status/success` etc.; Badge, Alert e Toast precisam de foreground, background e border independentes. **Nenhum `status/*` tem valor definido ainda** — nem a página original dava um, só a direção ("success → green, warning → amber, danger → red, info → blue/cyan"); ficam pendentes até uma tela real precisar.

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
| `border/default` | `color/mist/200` |
| `border/subtle` | `color/mist/100` |
| `action/primary/bg` | `color/indigo/600` |
| `action/primary/fg` | `color/white` |
| `action/danger/bg` | `color/red/700` (fora da página original — seção 5.1) |
| `action/danger/fg` | `color/white` |
| `focus/ring` | `color/indigo/600` |

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
| `border/default` | `color/ink/600` |
| `border/subtle` | `color/ink/700` |
| `action/primary/bg` | `color/indigo/550` |
| `action/primary/fg` | `color/white` |
| `action/danger/bg` | `color/red/700` (mesmo valor do Light; ver seção 20.1) |
| `action/danger/fg` | `color/white` |
| `focus/ring` | `color/indigo/400` |

`color/indigo/550 = #5B5FE8` foi escolhido, na página original, para manter contraste suficiente tanto com texto branco quanto contra a superfície escura. Por isso `text/link` no Dark não usa `color/indigo/550`: clareá-lo mais, para passar como texto sobre `bg/surface`, teria enfraquecido o contraste de `action/primary/fg` (branco) sobre ele. `text/link` usa `color/indigo/400`, o mesmo primitive já usado por `focus/ring`. A mesma lógica vale para `text/danger`: `color/red/700` já está no limite certo para servir de fundo sob texto branco (`action/danger/fg`), então `text/danger` no Dark usa um primitive próprio, `color/red/400`, mesma matiz clareada.

Nada no app define `[data-theme="dark"]` ainda — este bloco não tem efeito visível até existir um seletor de tema.

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
radius/sm   = 8px
radius/md   = 12px
radius/lg   = 16px
radius/xl   = 20px
radius/full = 9999px
```

Uso sugerido: input/button em `sm` ou `md`; cards em `md` ou `lg`; dialogs em `lg` ou `xl`; badges/pills em `full`.

## 10. Tipografia

Implementada em [`apps/web/src/styles/tokens/typography.css`](../apps/web/src/styles/tokens/typography.css). Sora e Inter são **servidas pelo próprio app**, pelos pacotes `@fontsource/sora` e `@fontsource/inter` importados em [`globals.css`](../apps/web/src/styles/globals.css), só nos pesos que a escala usa (Inter 400/500/600, Sora 600/700). Nenhuma requisição vai a uma CDN de fontes, então o IP de quem visita não chega a terceiro.

```
font/brand → Sora
font/ui    → Inter
```

Escala, cada degrau como uma custom property com o shorthand `font` (peso tamanho/entrelinha família):

| Token | Definição | Peso |
|---|---|---|
| `display/lg` | Sora 40/48 | 700 |
| `heading/xl` | Sora 32/40 | 700 |
| `heading/lg` | Sora 24/32 | 600 |
| `heading/md` | Sora 20/28 | 600 |
| `body/lg` | Inter 16/24 | 400 |
| `body/md` | Inter 14/20 | 400 |
| `label/md` | Inter 14/20 | 500 |
| `label/sm` | Inter 12/16 | 500 |
| `button/md` | Inter 14/20 | 600 |
| `caption` | Inter 12/16 | 400 |

Evitar dezenas de estilos tipográficos. Expandir só quando a UI real exigir. No Figma, quando existir, manter Text Styles equivalentes.

## 11. Shadows / elevation

Ainda não implementado — nenhuma tela precisou até agora. Tokens conceituais, da página original: `shadow/none`, `shadow/sm`, `shadow/md`, `shadow/lg`. A preferência é separar superfícies por contraste + border antes de depender de sombra forte.

## 12. Motion

Implementado em [`apps/web/src/styles/tokens/motion.css`](../apps/web/src/styles/tokens/motion.css).

```
motion/fast  = 120ms
motion/base  = 180ms
motion/slow  = 240ms
```

As curvas de easing (`motion/easing/standard`, `motion/easing/exit`) não têm valor concreto — nem a página original dava um, só o conceito. Ficam pendentes até existirem no Figma e no código com o mesmo significado, antes de qualquer componente usá-las. Motion explica mudança de estado, expansão, drag-and-drop ou contexto; nunca atrasa uma ação operacional.

## 13. Estratégia de componentes — shadcn + Ageniza

Este projeto **não usa shadcn/ui nem Tailwind hoje**. O dono do produto decidiu em 2026-09-28 (ver [`business/decisions/2026-09-28-o-repositorio-e-a-fonte-do-design-system-com-documento-e.md`](business/decisions/2026-09-28-o-repositorio-e-a-fonte-do-design-system-com-documento-e.md)) que a parte B adota shadcn/ui, copiado para o repositório como base de mecânica e acessibilidade, com as variáveis do shadcn como ponte para os tokens Ageniza (seção 15). Até a parte B entrar, vale a estratégia original:

- shadcn/ui como base mecânica e de acessibilidade; o código copiado para o repositório, adaptável sem criar dependência visual;
- Ageniza define tokens, aparência, semântica e API pública;
- construir no Figma, quando existir, só os componentes que uma tela real exigir;
- promover/adaptar componentes conforme a UI divergir do padrão original.

> shadcn define a mecânica do primitive; Ageniza define semântica, aparência e API pública.

`Button` já segue esse vocabulário hoje, implementado em [`packages/ui/src/index.tsx`](../packages/ui/src/index.tsx), mesmo sem shadcn instalado (mecânica própria, tokens da Ageniza):

```
Button
├── variant = primary | secondary | ghost | destructive
├── size = sm | md | lg
├── state = default | hover | focus | disabled | loading
```

O `variant` `outline` do shadcn corresponde ao nosso `secondary`; não expor `outline` como API pública da aplicação. Evitar cópias soltas como `Button Blue`, `Button New`, `Button Final 2`.

**Duas adaptações provisórias** no `Button`, até existirem os tokens que o vocabulário prevê: o hover de `primary` e `destructive` usa `filter: brightness(0.94)` no lugar de `action/primary/hover` e `action/danger/hover`, e o estado disabled usa `opacity: 0.55` no lugar de `action/disabled/fg`. No loading, o botão fica desabilitado, com `aria-busy`, e o rótulo fica transparente sem sair da árvore de acessibilidade, para o spinner aparecer na cor do variant.

`leadingIcon`/`trailingIcon`, do vocabulário original, ainda não entraram: nenhuma tela pediu ícone em botão até agora. Adicionar quando pedir.

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

Direção inicial, ainda não exercitada por nenhuma tela real:

- desktop-first para operação;
- grid de 12 colunas no desktop quando necessário;
- tablet responsivo;
- mobile funcional, sem exigir que toda tela complexa mantenha o mesmo arranjo do desktop — o portal do cliente é celular primeiro (ver `specs/clientes.md`), o que é a exceção deliberada a essa direção "desktop-first", não uma contradição: cada produto (operação vs. portal) tem sua prioridade de breakpoint.

Breakpoints se definem no código uma única vez. Não criar breakpoint diferente por tela.

## 20. Acessibilidade como foundation

Antes de aprovar um componente: contraste adequado; foco visível; estado disabled identificável; área clicável suficiente; label acessível; estado não comunicado só por cor; navegação por teclado quando aplicável.

### 20.1 Contraste — tabela final, aprovada em 2026-09-28

Pares de texto sobre fundo em Light e Dark, contra WCAG AA (4.5:1 para texto normal, 3:1 para texto grande e componentes de UI), recalculados com os valores finais do CSS (fórmula de luminância relativa do WCAG 2.x). **Todos os pares em uso passam.** Esta rodada corrigiu as quatro falhas que a migração inicial havia deixado (ver histórico abaixo), ajustando a luminosidade de dois primitives e introduzindo dois primitives novos, sem mudar a matiz de nenhum.

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
| `focus/ring` sobre `bg/canvas` | 6.01:1 | 5.95:1 |

**Restrição de uso, não falha:** `text/link` e `text/danger` só foram conferidos sobre `bg/canvas` e `bg/surface`, os fundos onde link e mensagem de erro aparecem hoje. Sobre `bg/elevated`/`bg/hover` no Dark eles cairiam a 3.46:1 e 3.22:1 — por isso o comentário em `themes/dark.css` e a nota na seção 6 dizem para não os usar ali. Se uma tela real precisar de link ou erro sobre esses fundos, isso volta a ser um ponto em aberto, não uma aprovação silenciosa.

`text/muted` sobre `bg/hover` no Dark (4.62:1) é o par aprovado mais apertado agora: qualquer mudança futura em `color/slate/400` ou `color/ink/700` precisa reconferi-lo.

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
