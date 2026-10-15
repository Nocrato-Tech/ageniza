# Roteiro de stories na Pauta: lista do período e estados por ícone e palavra

**Data.** 2026-10-15

**Contexto.** A issue #635 (épico #621) pede a lista e o modal de roteiro na linguagem da Pauta, com vazio que leva "Novo roteiro" e os estados enviado, gravado e rascunho distinguíveis por rótulo e ícone. A SPEC de conteúdo (seção 9) define o roteiro como um modal próprio e um indicador no dia do calendário; a tela não tinha lista. O canvas não tem artboard de roteiro. A consulta por período (`GET /agencies/:agencyId/clients/:clientId/contents`) já entrega `storyScripts` do período, com dia e estado.

**Decisão.**
- A "lista" é uma seção "Roteiros de stories" abaixo do calendário, só na visão Calendário, com os roteiros do mesmo período e do mesmo cliente que a grade já lê, em ordem de dia: dia por extenso, estado e "Abrir". Não há rota, filtro, paginação nem leitura nova.
- Vazio: "Nenhum roteiro de stories neste período" e o botão "Novo roteiro", que abre o roteiro novo em hoje. Sem `conteudo.operar` ou com o cliente arquivado, o vazio só diz que não há roteiro, sem botão. Com roteiros, "Novo roteiro" fica no cabeçalho da seção. Ele é secundário: o índigo cheio da página continua sendo "Nova publicação".
- Os três estados usam o `StatusTag` do `@ageniza/ui`, com forma e palavra: rascunho é o círculo vazio de "em produção", enviado é o relógio de "aguardando" e gravado é o visto de "pronto". O mapa é só de ícone: a palavra é a do roteiro (Rascunho, Enviado, Gravado), e a cor fica no ícone. O mesmo `StatusTag` marca o dia da grade, a lista e o cabeçalho do modal, no lugar do tracejado que antes distinguia o rascunho.
- O modal é o `Dialog` com `Field` em cada campo e a ação de enviar como a única primária, por último no pé; salvar rascunho é secundário e cancelar, ghost.
- Sem mascote: a página é de trabalho cheia (docs/brand.md) e o vazio da seção é uma linha de uma tela com calendário.

**Consequência.** Nenhuma rota, tabela ou permissão muda, e nenhum dado novo é pedido à API. A lista é limitada ao período da grade (mês ou semana, com o teto de 93 dias da consulta); uma lista de todos os roteiros do cliente, fora do calendário, exigiria uma listagem própria na API e não existe issue para ela porque nenhuma tela a pede hoje.

**Origem.** Implementação da #635 (épico #621); aceite visual comum do épico.

**Validação.** Pendente de validação do dono.
