# O perfil do cliente tem cinco abas, a aba Conteúdos volta, e Tarefas e Relatórios saem (na agência e no portal)

**Data.** 2026-11-11

**Contexto.** O perfil do cliente tem seis abas (Geral, Mídias, Tarefas, Estudo de marca, Relatórios e Acessos), sem contagens, e duas delas (Tarefas e Relatórios) são esqueletos sem função. A decisão [`2026-11-04-o-perfil-do-cliente-nao-tem-copia-do-calendario`](2026-11-04-o-perfil-do-cliente-nao-tem-copia-do-calendario.md) tirou a aba de calendário porque o calendário passou a ter dois endereços. O quadro do redesenho (r0) tem **Visão geral, Conteúdos (16), Mídias (171), Marca e Acessos (3)**, e no portal Início, Conteúdos, Marca e "Pedidos da agência".

**Decisão.**

1. **Cinco abas na agência**, nesta ordem: **Visão geral**, **Conteúdos**, **Mídias**, **Marca** e **Acessos**, cada uma com a contagem que o quadro mostra: os conteúdos não cancelados do mês, os arquivos do cliente e as pessoas com acesso ativo ao portal. A contagem só aparece para quem tem a permissão da aba (`conteudo.visualizar` em Conteúdos e Mídias; `cliente.convidar_usuario` em Acessos). "Geral" passa a se chamar "Visão geral" e "Estudo de marca", "Marca".
2. **A aba Conteúdos volta, e não é um calendário.** É a lista dos conteúdos do cliente **agrupada por quem precisa agir** (Esperando o cliente, Atrasado, Em produção, Aprovado e agendado), com a opção de agrupar por data ou por formato, a capa, o formato, a data, quem cuida e o estado. "Nova publicação" e "Abrir no Calendário Editorial" levam ao calendário; o calendário continua tendo **um endereço só** (`/conteudos/:clienteId`). Quem tem `conteudo.visualizar` vê a aba.
3. **Tarefas e Relatórios saem do perfil e do portal.** Eram esqueletos sem dado nem controle. O item "Relatórios" sai da navegação do portal, da barra inferior e do tour. Quando o relatório interno ou a tarefa forem decididos (pontos em aberto #150 e Tarefas), a aba volta com o módulo.
4. **Portal.** A navegação passa a ser **Início, Conteúdos, Marca e "Pedidos da agência"**, com o número de pedidos abertos como selo. "Pedidos da agência" lista os pedidos de material abertos (ver [`2026-11-11-estrutural-o-pedido-de-material-ganha-titulo`](2026-11-11-estrutural-o-pedido-de-material-ganha-titulo.md)).
5. **A Visão geral** traz quatro blocos (Estudo de marca "5 de 7", Conversas, Portal e Mídias "171 arquivos em 5 pastas"), os pedidos de material com "Pedir material", o Cadastro com "Editar" próprio e a meta "cliente desde <mês e ano>". O cabeçalho tem a trilha "Clientes > nome", a etiqueta do estado, o @, "Editar", o menu "…" e a ação principal "Abrir no Calendário Editorial".
6. **Endereços.** `/clientes/:clienteId/conteudos` passa a abrir a aba; `/conteudos/novo` e `/conteudos/:conteudoId` continuam redirecionando ao calendário. Os endereços de Tarefas e de Relatórios deixam de existir ("não encontrado").

**Substitui.**

- O **item 1** de [`2026-11-04-o-perfil-do-cliente-nao-tem-copia-do-calendario`](2026-11-04-o-perfil-do-cliente-nao-tem-copia-do-calendario.md) ("sem aba") e, no **item 4**, só o redirecionamento de `/clientes/:clienteId/conteudos` (que agora é a aba). Os itens 2, 3 e 5 (o botão, o "voltar" e os destinos da carteira) continuam, e o calendário continua sem cópia.
- A seção "Aba esqueleto" e a linha "Relatório" em `specs/clientes.md` (e a nota de que "a aba Relatórios nasce reservada" em [`2026-09-26-integracao-com-a-meta-fica-fora-do-mvp-e-publicar-e-medir`](2026-09-26-integracao-com-a-meta-fica-fora-do-mvp-e-publicar-e-medir.md)): nenhuma aba nasce reservada; a regra "nunca dado fictício, nunca controle que não funciona" fica.
- O trecho de [`2026-10-15-detalhe-do-cliente-na-pauta-sem-dados-que-a-api-nao-entrega`](2026-10-15-detalhe-do-cliente-na-pauta-sem-dados-que-a-api-nao-entrega.md) que mantinha as abas e as contagens ausentes, no que a API passa a entregar as contagens.

**Consequência.**

- Não é estrutural: nenhuma tabela, policy ou permissão muda. O detalhe do cliente ganha as contagens e o resumo de Mídias (leitura, sob as permissões que já valem). A aba Conteúdos usa a rota de período por cliente que já existe.
- `specs/clientes.md` e `specs/conteudo.md` descrevem as cinco abas; os fluxos mobile também.

**Origem.** Pedido do dono do produto em 2026-11-11 (tudo igual ao quadro) e decisão do maestro de tirar os esqueletos (riscos 6 e 7 do inventário).

**Validação.** Pendente de validação do dono.
