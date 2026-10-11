# Consulta por período: teto de 500 itens e formato da resposta

**Data.** 2026-10-11

**Esta é uma mudança estrutural.** O formato de resposta da consulta por período é o que as rotas de Tarefas (kanban) e do Dashboard vão copiar ([`specs/conteudo.md`](../../../specs/conteudo.md), seção 6, "Consulta por período"), e é fixado aqui antes de a primeira rota de conteúdo ou de roteiro o usar.

**Contexto.** A SPEC diz que calendário e feed consultam por intervalo (`from`, `to`), com "teto de 93 dias e teto de itens; acima disso, 400. Não pagina", e [`2026-10-01-conteudo-impacto-estrutural.md`](2026-10-01-conteudo-impacto-estrutural.md) (ponto 4) repete o desenho sem número de itens nem formato. A #254 (conteúdos por período) e a #258 (roteiros de stories) são as duas primeiras rotas a usá-lo, e o dono aprovou em 2026-10-11, na #254, o que está abaixo.

**Decisão.**

1. **`from` e `to` são datas `AAAA-MM-DD`, inclusivas nas duas pontas.** Um período de um dia tem `from` igual a `to`. Data que não existe no calendário (`2026-02-30`), `to` antes de `from`, `to` ausente e parâmetro que a rota não declara são `400`.
2. **Teto de 93 dias**, contados com as duas pontas (de `2026-10-01` a `2027-01-01` são 93). Acima disso, `400`.
3. **Teto de 500 itens.** Quando a rota devolve conteúdos e roteiros, o teto soma os dois. Acima de 500, `400`: a resposta nunca é truncada, porque uma lista cortada em silêncio parece completa.
4. **Sem paginação.** A consulta devolve o período inteiro, e a tela que precisar de mais divide o período.
5. **A resposta é `{ data, meta: { from, to, count } }`.** `meta.from` e `meta.to` repetem o período consultado e `meta.count` é o total de itens de `data` (a soma, quando há dois tipos). Na rota de conteúdos da agência, `data` é `{ contents, storyScripts }`; nas rotas de um tipo só, é a lista. Este é o formato que Tarefas e Dashboard copiam.

**Consequência.**

- O contrato fixa os dois tetos como constantes e a consulta é validada pelo schema da rota, antes do banco. Quem copiar o formato importa as constantes ou as declara com o mesmo valor e cobre as duas bordas (93 e 94 dias, 500 e 501 itens).
- A #254 e a #258 têm cada uma o helper do período, e a unificação deles é uma issue própria.
- Mudar um teto ou o formato depois de uma rota do portal ou da tela usá-lo reabre esta decisão.

**Origem.** Aprovação do dono em 2026-10-11 na #254; SPEC de conteúdo, seção 6; revisão do #533.

**Validação.** Validada pelo dono em 2026-10-11.
