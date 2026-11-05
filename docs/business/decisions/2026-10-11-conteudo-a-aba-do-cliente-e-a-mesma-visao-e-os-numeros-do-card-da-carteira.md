# Conteúdo em Clientes: a aba do cliente é a mesma visão, com o modal na própria aba, e o card da carteira mostra os três números

**Data.** 2026-10-11

**Contexto.** A #272 pede que a aba Conteúdos do detalhe do cliente (`/agencia/:agenciaId/clientes/:clienteId/conteudos`) mostre "a mesma visão de Conteúdos daquele cliente" e que os indicadores da #261 e a ordem por atraso entrem na carteira (`specs/conteudo.md` seções 2 e 7). A SPEC não diz onde mora o modal do conteúdo quando se está na aba, quem vê a aba, nem como os três números aparecem no card. O que ela deixa em aberto, e alguém tentaria de novo:

**Decisão.**

1. **Uma visão só, em dois endereços.** A aba reaproveita a tela do cliente de Conteúdos (calendário, feed e Pastas), com o cliente fixo: sem o seletor de clientes em stories e sem o cabeçalho do cliente, que o detalhe já tem. Calendário, período (`visao`, `data`), vista (`vista`) e pasta (`pasta`, `subpasta`, `pagina`) usam os mesmos parâmetros nos dois endereços.
2. **O modal fica na aba.** Abrir um conteúdo, o "+" do dia e "Criar conteúdo" levam a `/clientes/:clienteId/conteudos/:conteudoId` e `/clientes/:clienteId/conteudos/novo`, e fechar volta à aba, com o período e o endereço da carteira. Quem está na tela de Conteúdos continua em `/conteudos/:clienteId/...`. A pessoa nunca é tirada de onde estava só porque abriu um conteúdo.
3. **Os dois endereços se ligam, sem perder nada.** Na aba há "Abrir na tela de Conteúdos"; na tela de Conteúdos, "Abrir no cadastro do cliente". Os dois levam o mesmo cliente, o mesmo período e a mesma vista, e o estado de navegação da carteira, para que "← Clientes" ainda volte à busca e à página de onde a pessoa saiu.
4. **Quem vê a aba.** A aba exige `conteudo.visualizar` (a rota do detalhe já exige `cliente.visualizar`). Sem a permissão a aba não aparece e o endereço digitado, com ou sem conteúdo, `novo` ou pasta, é o mesmo "não encontrado" da página inteira, sem o cabeçalho do cliente. Vendas e Financeiro não a veem, como a SPEC manda. É regra de menu e de rota (UX); a API continua checando cada rota.
5. **O card da carteira.** Para quem recebe `contentIndicators` e tem `conteudo.visualizar`, a faixa reservada passa a mostrar três números, em lista com nome acessível "Indicadores de conteúdo": "N pendentes · N em revisão · N atrasos" (singular em 1, "0" mostrado). O atraso maior que zero recebe a cor de perigo do design system. Para quem não tem a permissão, a faixa continua a reservada, sem número, e um `contentIndicators` que vazasse na resposta não é mostrado (a autorização responde à permissão, não ao corpo). O card arquivado não tem faixa.
6. **A ordem é da API.** A tela não ordena e não manda `sort`: a carteira chega na ordem de atenção (atraso primeiro só para quem lê Conteúdo, depois sugestão aguardando, depois o nome) e é mostrada como chega.

**Consequência.**

- O modal do conteúdo, o calendário e o feed não ganham cópia: o endereço em que vivem sai de um contexto (`content-address.ts`), e a tela do cliente recebe `pinned` quando está na aba.
- A tela de Conteúdos ganha o link para o cadastro do cliente, que a SPEC não desenhava; sem ele a navegação entre os dois endereços só existiria pela barra do navegador.
- Se o dono quiser a aba só com o calendário, ou o modal sempre na tela de Conteúdos, é trocar a decisão 2 e o contexto de endereço.

**Origem.** Issue #272; SPEC `specs/conteudo.md` seções 2 e 7; decisões [`2026-10-11-indicadores-de-conteudo-da-carteira-e-ordem-por-atraso.md`](2026-10-11-indicadores-de-conteudo-da-carteira-e-ordem-por-atraso.md) (#261) e [`2026-10-11-conteudo-o-item-exige-conteudo-e-carteira.md`](2026-10-11-conteudo-o-item-exige-conteudo-e-carteira.md), que deixou a aba fora.

**Validação.** Pendente de validação do dono.
