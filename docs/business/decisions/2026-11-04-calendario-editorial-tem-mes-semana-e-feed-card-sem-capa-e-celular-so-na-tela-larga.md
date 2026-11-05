# O Calendário Editorial tem Mês, Semana e Feed, o card não tem capa e o celular só aparece na tela larga

**Data.** 2026-11-04

**Contexto.** Em 2026-10-16, a decisão [`2026-10-16-pastas-viram-a-aba-midias-do-cliente-e-o-feed-deixa-de-ser-vista`](2026-10-16-pastas-viram-a-aba-midias-do-cliente-e-o-feed-deixa-de-ser-vista.md) tirou o seletor de vistas da tela de Conteúdos, porque o celular ao lado do calendário já era o feed. No teste manual de 2026-11-04 o dono quis o feed também como vista inteira, e mudou o nome da tela e o desenho do card. Essas mudanças já estavam na tela, sem decisão registrada, e a `specs/conteudo.md` se contradizia sobre elas.

**Decisão.**

1. **Seletor Mês, Semana e Feed.** A tela volta a ter um seletor de vistas, agora com três opções: Mês, Semana e Feed. A vista fica no endereço, em `?visao=` (`semana` e `feed`; o mês é a vista padrão e não leva parâmetro). A vista Feed é a grade do período em tela cheia, trinta posts por página, só com os posts planejados (sem casa vazia). Ela não é a mesma coisa que o celular ao lado do calendário, que mostra o feed inteiro do cliente (decisão `2026-11-04-o-celular-do-calendario-mostra-o-feed-inteiro-do-cliente`).
2. **Nome.** A tela, o item do menu e o botão do perfil do cliente se chamam **Calendário Editorial**. O título é um só, antes e depois de escolher o cliente. O portal e o link de aprovação seguem com "Conteúdos".
3. **Card sem capa.** O card do calendário é compacto e **não mostra a capa**: título, formato, data e hora, o estado (com o tom do estado), o alerta de prazo ou atraso e o percentual das subtarefas. Um toque em qualquer ponto do card abre o conteúdo; arrastar não abre. O dia com muitos conteúdos mostra o resumo **+N**, que abre a semana daquele dia.
4. **Celular só na tela larga.** O celular ao lado do calendário aparece a partir de 48 rem de largura e, abaixo disso, **fica escondido**. Em tela estreita o caminho para ver o feed é a vista **Feed** do seletor. Entre 48 rem e 80 rem o celular fica abaixo do calendário.

**Substitui em parte** a decisão de 2026-10-16 `pastas-viram-a-aba-midias-do-cliente-e-o-feed-deixa-de-ser-vista`, no que ela diz que o seletor de vistas sai inteiro e que `?vista=feed` não tem efeito: o seletor volta com a vista Feed. O resto dela (as pastas na aba Mídias, o redirecionamento de `?vista=pastas`) segue valendo.

**Consequência.**

- Nenhuma rota, tabela, migration ou permissão: é só a tela.
- A `specs/conteudo.md` (seção 7) passa a descrever o seletor, o card sem capa e o celular só na tela larga.
- Quem desistir do celular escondido no celular de verdade (o aparelho real) precisa de uma nova decisão: hoje a vista Feed é o caminho.

**Origem.** O dono, no teste manual de 2026-11-04, nesta conversa.

**Validação.** Pendente de validação do dono.
