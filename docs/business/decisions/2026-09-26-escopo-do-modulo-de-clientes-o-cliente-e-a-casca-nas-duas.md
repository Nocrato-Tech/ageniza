# Escopo do módulo de clientes: o cliente e a casca, nas duas frentes
**Data.** 2026-09-26

**Contexto.** O bloco 0 da entrevista levantou, para a área da agência, uma listagem em cards e um detalhe com abas — Geral, Conteúdos, Tarefas, Estudo de marca e Relatórios —, e para o portal um cliente dono do negócio que entra para acompanhar o calendário, aprovar, comentar, ver relatório e o estudo da própria marca. A maior parte disso depende de entidades que não existem: não há conteúdo, tarefa, atribuição nem comentário no banco, e `ClientAssignment`, citado em decisões anteriores, também não existe em nenhuma migration. Ao mesmo tempo, `clients` só tem policy de `SELECT`: hoje não há como criar um cliente pelo produto, embora a rota de convidar usuário de cliente já exista.

**Decisão.** Clientes entrega **o cliente e a casca**: cadastro, foto, arquivar e reativar, listagem em cards com busca, página de detalhe com as abas, estudo de marca, e as pessoas do portal — convidar, reenviar, cancelar, remover. As abas **Conteúdos**, **Tarefas** e **Relatórios** e os indicadores do card — pendentes, em revisão, atrasados — nascem com **área reservada**, preenchida pelas entrevistas de Conteúdo, Tarefas e Financeiro/Dashboard.

O **portal do cliente nasce neste módulo** como casca: entrada, onboarding de boas-vindas, navegação e estudo de marca. Calendário, aprovação e comentário de conteúdo chegam com Conteúdo.

**Consequência.** O que o bloco 0 levantou e não pertence a Clientes é o **bloco 0 já colhido da entrevista de Conteúdo**, e não deve ser perguntado do zero lá: calendário editorial com arrastar para outra data e criar numa data; card com miniatura e hover detalhado; modal de conteúdo com abas Descrição e Atribuição; tipos reels, vídeo longo, VSL e carrossel; alerta de prazo a dois dias e de atraso; capa de vídeo; prévia ao vivo do post e simulador de feed do Instagram com grade de nove e navegação entre períodos; conteúdo sempre ligado a uma pasta de mídia; tarefas por conteúdo com responsável, prazo e percentual de conclusão.

Fica em aberto, com gatilho: **o portal não é liberado a cliente real antes de Conteúdo entregar a aprovação** — um portal cujo único conteúdo é o estudo de marca não entrega o valor pelo qual o cliente entra.

**Origem.** Decidido em sessão (entrevista do módulo de clientes).

