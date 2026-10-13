# Tokens da Pauta: valores do claro e degraus de tipografia mantidos

**Data.** 2026-10-13

**Contexto.** A #622 troca Sora e Inter por Archivo e Geist e leva os tokens da folha Identidade do canvas Pauta para `apps/web/src/styles`. A folha dá o fundo e o título do formato nos dois temas, mas a etiqueta só no escuro, e não diz o que acontece com os degraus de texto que as telas usam e a escala nova não tem (`heading-md`, `body-lg`, `label-md`, `label-sm`, `button-md`). Nenhuma tela muda nesta tarefa.

**Decisão.**
1. **Cores.** Entram só `color/violet/400 #A78BFA` e `color/teal/700 #0F766E`; todo o resto dos tokens novos é `color-mix` (sRGB) sobre primitives que já existem.
2. **Formato no claro (portal).** Fundo e título como na folha (carrossel `teal/500 10%` sobre branco e `teal/700`; reels `violet/600 7%` sobre branco e `violet/600`; estático `mist/100` e `ink/900`). A etiqueta preenchida no claro, que a folha não traz, usa o título como fundo com texto branco (`teal/700` 5,5:1, `violet/600` 5,7:1, `slate/600` 7,6:1). Cada formato ganha por isso um par `format/*/tag/bg` e `format/*/tag/fg`, além de `bg` e `fg`.
3. **Estado no claro.** `status/*/fg`: ajuste `indigo/600`, aguardando `violet/600`, pronto `teal/700`, atrasado `red/700`, publicado `slate/600`, em produção `slate/500`. No escuro, `indigo/400`, `violet/400`, `teal/500`, `red/400`, `slate/400` e `slate/400`. A cor vai no ícone (3:1); o texto do rótulo continua `text/secondary`.
4. **Escala.** `display/lg` passa a 48/52 (nenhuma tela o usava), `heading/xl` 32/38, `heading/lg` 22/28, `title/md` 16/24, `body/md` 14/21 e `caption` 12/16. Os degraus que as telas ainda usam ficam apontados para a escala nova até cada tela ser refeita: `heading/md` é `heading/lg` (mesma entrelinha de 28), `label/sm` é `caption`, `body/lg` segue 16/24 em Geist 400, `label/md` e `button/md` ficam em 14/21.
5. **Largura do Archivo.** O shorthand `font` não carrega `font-stretch`, então cada largura da escala é uma família sobre os mesmos arquivos do `@fontsource-variable/archivo` (`Archivo Expanded`, 118%, e `Archivo Semi Expanded`, 112%).
6. **Raio.** `radius/sm` 6, `md` 10, `lg` 14 e `xl` 20: os valores novos entram nos mesmos nomes, e todo canto do app encolhe de uma vez.
7. **Números.** `tabular-nums` fica na raiz; o shorthand `font` o reseta, então a regra que usa um degrau e mostra número o repete.

**Consequência.** O contraste de cada par novo está na seção 20.1 de `docs/design-system.md` e é conferido por `apps/web/src/styles/tokens.test.ts`. Os cantos do app e o peso do `caption` (400 para 500) mudam em todas as telas; nenhum layout muda. Quando a última tela deixar de usar um degrau mantido, o degrau sai.

**Origem.** Issue #622, épico #621, folha Identidade do canvas Pauta.

**Validação.** Pendente de validação do dono.
