# Detalhe do cliente na Pauta: só o que a API entrega, abas como links e uma ação primária por tela

**Data.** 2026-10-15

**Contexto.** A issue #637 (épico #621) redesenha o detalhe do cliente, o estudo de marca, a conversa por seção e os acessos ao portal. O canvas de referência não tem artboard do detalhe (só Clientes, Calendário, Modal e Portal), então a referência é o crachá da carteira (#636) e o design system. As abas do detalhe são rotas (`/geral`, `/estudo-de-marca`, `/acessos`…) que os testes endereçam como links dentro de uma navegação com `aria-current`, e o componente `Tabs` do `@ageniza/ui` é um `tablist` de botões que renderiza o próprio painel. A conversa é o mesmo componente na agência, no portal e no modal do conteúdo (esse é do #633).

**Decisão.**
- Nenhum dado novo: o cabeçalho mostra o que o detalhe já entrega (foto ou iniciais, nome, @, situação e encerramento). Segmento fica só no Cadastro, como hoje. Responsável, "cliente desde" e indicadores de conteúdo não aparecem, porque `GET /agencies/:agencyId/clients/:clientId` não os entrega; a carteira registrou o mesmo vazio para a listagem na #660.
- As abas continuam sendo links de verdade, desenhados como o `Tabs` (mesmas classes `ui-tabs__list` e `ui-tabs__tab`, sublinhado em tinta, rolagem horizontal no celular). Trocar por `Tabs` mudaria o papel (de link para `tab`) e a URL deixaria de ser a fonte da aba. Uma aba que vira rota por si só continua sendo link.
- Uma única ação primária por tela: "Editar" do cabeçalho passa a `secondary`; "Convidar" em Acessos é a primária da aba e, enquanto ninguém tem acesso, a primária é a do estado vazio e a do cabeçalho vira `secondary`.
- A cor do realce aparece na Geral só quando há conversa aguardando a agência (a vez de quem olha) e, na conversa do estudo, no selo "aguardando você".
- Estado vazio de seção do estudo, de persona e de acessos usa `EmptyState` com o que falta e o botão que resolve; sem permissão, só o que falta. A coruja entra uma vez por tela, e só no vazio de Acessos de um cliente ativo (o estudo tem sete seções e a regra da marca é uma coruja por tela, nunca numa tela de trabalho cheia).
- A conversa do estudo troca cartões dentro de cartão por linhas separadas por filete, com a regra restrita ao estudo (`.brand-study .conversation…`); o portal e o modal do conteúdo mantêm o visual atual até as suas telas. Os textos que os testes fixam (`+ conversa`, `← Clientes`) não mudam.
- A grade da carteira deixa de ter breakpoint próprio: colunas por `repeat(auto-fill, minmax(min(100%, 20rem), 1fr))`, o que dá uma coluna a 768 px com a navegação aberta (o crachá de 209 px da revisão da #662 cortava o selo e quebrava "pendentes") e três a 1440 px. `40.0625rem` passa a constar na §19 como complemento de `40rem`.

**Consequência.** Nenhuma rota, tabela ou permissão muda. Quem quiser as abas como `tablist` de botões precisa decidir antes se a aba continua na URL e como os testes passam a endereçá-las.

**Origem.** Implementação da #637 (épico #621); aceites adicionais da revisão da #662 registrados na issue.

**Validação.** Pendente de validação do dono.
