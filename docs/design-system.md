# Design system

Como a identidade visual da Ageniza vira um sistema de UI consistente entre design e código. O objetivo é impedir que telas criem cor, espaçamento, tipografia e componente de forma independente.

**O repositório é a fonte de verdade.** Até 2026-09-28 este conteúdo vivia numa página do Notion, ["UI System — Figma, Design Tokens & CSS"](https://app.notion.com/p/3d886d2ba8b08172a3fbcc31e1548c31) (histórico — não usar como referência de trabalho); o dono do produto decidiu que passa a viver aqui, com uma página em `/design-system` no próprio app mostrando os tokens e componentes ao vivo (em preparo, PR separado). Ver a entrada de 2026-09-28 em [`decisions.md`](business/decisions.md). O Notion permanece como registro histórico da decisão original, nunca mais como referência para implementar.

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
- **Este documento** define princípios, tabelas de valor e a Definition of Done.
- **Figma** representa a aplicação visual dos tokens, componentes e telas, quando existir — hoje não existe nenhum arquivo Figma para este projeto. Ele entra no refino de cada tela (ver a entrada de 2026-09-28 em `decisions.md`), não antes.
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
| `color/ink/800` | `#1F2937` | superfície escura — **proposto, pendente de aprovação do humano** |
| `color/ink/700` | `#374151` | superfície escura elevada / hover — **proposto, pendente de aprovação do humano** |
| `color/ink/600` | `#4B5563` | borda no Dark — **proposto, pendente de aprovação do humano** |
| `color/indigo/600` | `#4F46E5` | marca / ação principal Light |
| `color/indigo/550` | `#5B5FE8` | ação principal Dark; mantém contraste com texto branco e superfície |
| `color/indigo/400` | `#818CF8` | anel de foco no Dark — **proposto, pendente de aprovação do humano** |
| `color/violet/600` | `#7C3AED` | identidade / destaque |
| `color/teal/500` | `#14B8A6` | acento / fluxo |
| `color/slate/600` | `#475569` | texto secundário no Light |
| `color/slate/500` | `#64748B` | texto muted no Light |
| `color/slate/400` | `#94A3B8` | texto muted no Dark — **proposto, pendente de aprovação do humano** |
| `color/slate/300` | `#CBD5E1` | texto secundário no Dark — **proposto, pendente de aprovação do humano** |
| `color/mist/200` | `#E8ECF4` | bordas / superfícies |
| `color/mist/100` | `#F4F6FA` | hover / borda sutil no Light — **proposto, pendente de aprovação do humano** |
| `color/cloud/50` | `#F8FAFC` | canvas claro |
| `color/white` | `#FFFFFF` | branco puro, como token — **proposto, pendente de aprovação do humano** |

### 5.1 Lacuna encontrada nesta migração

A página original referenciava, nas tabelas de semantic tokens (seções 6 e 7) e no bloco de CSS (seção 16), oito tokens sem valor definido em lugar nenhum: `color/mist/100`, `color/ink/800`, `color/ink/700`, `color/ink/600`, `color/slate/300`, `color/slate/400`, `color/indigo/400` e `color/white`. Os valores que a página definia batem exatamente com a paleta Tailwind na mesma família e no mesmo degrau (`slate/600` = Tailwind `slate-600` `#475569`, `indigo/600` = Tailwind `indigo-600` `#4F46E5`, `ink/900` = Tailwind `gray-900` `#111827`, `cloud/50` = Tailwind `slate-50` `#F8FAFC`). Os seis primeiros seguem a mesma família Tailwind, no mesmo degrau que falta (`gray-800/700/600`, `slate-400/300`, `indigo-400`). `color/mist/100` não tem correspondente exato no Tailwind — é a mesma cor de `mist/200`, misturada 50% com branco. `color/white` é `#FFFFFF` literal; a página já o usava, só não o tinha como token nomeado, embora o cite por nome na seção 6.

Todos os oito estão marcados **"proposto, pendente de aprovação do humano"** no código e nesta tabela, e não devem ser tratados como decididos.

Um nono valor entrou por necessidade própria desta migração, fora da lista acima e da página original: `color/red/700 = #B42318`, usado em `action/danger/bg`. A página não define nenhuma cor de dano com valor — só a direção ("danger → red") — mas o vocabulário de Button que esta mesma tarefa pede (`variant = primary | secondary | ghost | destructive`) exige uma. `#B42318` é o vermelho que `packages/ui` já usa em produção hoje (antes chamado `tone="danger"`); esta migração o transforma em token, sem mudar o valor. Também está **proposto, pendente de aprovação do humano** — mais que os outros oito, porque não vem de nenhum valor que a página já tivesse escrito em algum lugar.

## 6. Semantic tokens — Light

Implementados em [`apps/web/src/styles/tokens/semantic.css`](../apps/web/src/styles/tokens/semantic.css) (`:root`, o tema padrão).

| Token | Aponta para |
|---|---|
| `bg/canvas` | `color/cloud/50` |
| `bg/surface` | `color/white` |
| `bg/elevated` | `color/white` |
| `bg/hover` | `color/mist/100` (proposto) |
| `text/primary` | `color/ink/900` |
| `text/secondary` | `color/slate/600` |
| `text/muted` | `color/slate/500` |
| `border/default` | `color/mist/200` |
| `border/subtle` | `color/mist/100` (proposto) |
| `action/primary/bg` | `color/indigo/600` |
| `action/primary/fg` | `color/white` (proposto) |
| `action/danger/bg` | `color/red/700` (proposto, fora da página original — seção 5.1) |
| `action/danger/fg` | `color/white` (proposto) |
| `focus/ring` | `color/indigo/600` |

`text/muted` continua apto para captions, metadata e helper text. Conteúdo disabled usa `action/disabled/fg` (sem valor ainda), não `text/muted`.

## 7. Semantic tokens — Dark

Implementados em [`apps/web/src/styles/themes/dark.css`](../apps/web/src/styles/themes/dark.css) (`[data-theme="dark"]`). Dark não é uma inversão automática do Light.

| Token | Aponta para |
|---|---|
| `bg/canvas` | `color/ink/900` |
| `bg/surface` | `color/ink/800` (proposto) |
| `bg/elevated` | `color/ink/700` (proposto) |
| `bg/hover` | `color/ink/700` (proposto) |
| `text/primary` | `color/cloud/50` |
| `text/secondary` | `color/slate/300` (proposto) |
| `text/muted` | `color/slate/400` (proposto) |
| `border/default` | `color/ink/600` (proposto) |
| `border/subtle` | `color/ink/700` (proposto) |
| `action/primary/bg` | `color/indigo/550` |
| `action/primary/fg` | `color/white` (proposto) |
| `action/danger/bg` | `color/red/700` (proposto — mesmo valor do Light; ver seção 20.1) |
| `action/danger/fg` | `color/white` (proposto) |
| `focus/ring` | `color/indigo/400` (proposto) |

`color/indigo/550 = #5B5FE8` foi escolhido, na página original, para manter contraste suficiente tanto com texto branco quanto contra a superfície escura.

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

Implementada em [`apps/web/src/styles/tokens/typography.css`](../apps/web/src/styles/tokens/typography.css), com Sora e Inter carregadas em [`apps/web/index.html`](../apps/web/index.html).

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

Este projeto **não usa shadcn/ui nem Tailwind hoje**. Quando um dos dois entrar, vale a estratégia original:

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

### 20.1 Contraste conferido nesta migração

Todos os pares texto/fundo semânticos definidos nas seções 6 e 7, em Light e Dark, incluindo os oito valores propostos na seção 5.1, foram conferidos contra WCAG AA (4.5:1 para texto normal):

| Par | Light | Dark |
|---|---|---|
| `text/primary` sobre `bg/canvas` | 16.96:1 | 16.96:1 |
| `text/primary` sobre `bg/surface` | 17.74:1 | 14.03:1 |
| `text/secondary` sobre `bg/surface` | 7.58:1 | 9.89:1 |
| `text/muted` sobre `bg/surface` | 4.76:1 | 5.72:1 |
| `action/primary/fg` sobre `action/primary/bg` | 6.29:1 | 4.94:1 |
| `action/danger/fg` sobre `action/danger/bg` | 6.57:1 | 6.57:1 |

Todos passam. `text/muted` sobre `bg/surface` no Light é o par mais apertado (4.76:1, contra o mínimo de 4.5:1) — qualquer proposta futura de mudar `color/slate/500` precisa reconferir esse par.

Para `action/danger/bg`, cheguei a considerar um vermelho mais claro no Dark (Tailwind `red-500 #EF4444`, seguindo a mesma lógica que deu a `indigo/550` ao invés de `indigo/600` no Dark) — ele falha AA para texto normal (3.76:1). Por isso `action/danger/bg` usa o mesmo `color/red/700` nos dois temas: já passa nos dois, e evita propor um décimo valor sem necessidade.

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

## 23. Definition of Done de UI

Isto é critério de aceite, não aspiração. Uma entrega visual só está concluída quando:

- [ ] usa tokens oficiais;
- [ ] não contém HEX arbitrário relevante;
- [ ] usa tipografia oficial;
- [ ] respeita a escala de espaço;
- [ ] estados hover/focus/disabled definidos quando aplicável;
- [ ] funciona em Light e Dark quando o componente exigir;
- [ ] acessibilidade básica validada (seção 20);
- [ ] **quando houver Figma**, Figma e código usam o mesmo vocabulário de componente — este item não se aplica enquanto o projeto não tiver um arquivo Figma, e a sequência esboço → código → refino (ver `decisions.md`) significa que o Figma só entra depois que a tela já está no ar;
- [ ] componente novo foi criado só quando não existia equivalente reutilizável.

> A meta não é construir um design system gigantesco antes do produto. A meta é garantir que cada nova tela aumente um sistema consistente, em vez de criar uma nova linguagem visual a cada implementação.
