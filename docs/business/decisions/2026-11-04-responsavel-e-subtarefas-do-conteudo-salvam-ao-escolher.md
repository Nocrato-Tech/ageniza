# O responsável do conteúdo e as subtarefas salvam na hora, sem botão de confirmar

**Data.** 2026-11-04

**Contexto.** Na aba Atribuição do conteúdo, trocar o responsável pedia escolher a pessoa e apertar "Trocar responsável", e criar uma subtarefa pedia abrir um formulário e apertar "Criar subtarefa". A decisão de 2026-10-11 (as ações do conteúdo no modal esperam o salvar) vale para as ações com efeito sobre o conteúdo (enviar, aprovar, publicar, cancelar, reagendar), não para estas duas.

**Decisão.**

1. **Responsável pelo conteúdo.** Escolher a pessoa no seletor já salva (`PATCH` do conteúdo), sem botão. A tela mostra "Salvando…" e depois "Salvo", discretos. Se o servidor recusar, o seletor volta ao valor salvo (lido de novo do servidor) e a tela diz o motivo.
2. **Sem corrida.** Uma escolha feita enquanto outra está a caminho espera e sai depois dela, na ordem das escolhas; o valor que fica é sempre o da última escolha. Se a anterior falhar, a fila é descartada e o seletor volta ao salvo.
3. **Responsável por uma subtarefa.** Escolher a pessoa no seletor da própria subtarefa salva na hora, com o mesmo tratamento. O formulário "Editar" passa a cuidar só de título e prazo.
4. **Criar subtarefa.** A linha de nova subtarefa está sempre à vista para quem pode criar; enviar a linha (Enter no título ou "Adicionar subtarefa") cria na hora. Título, responsável e prazo continuam obrigatórios: sem eles nada é enviado e a linha diz o que falta. O que a pessoa digitou não se perde quando o servidor recusa; só uma subtarefa salva esvazia a linha.
5. **O que não muda.** As permissões (`conteudo.operar` e `conteudo.aprovar_pela_agencia` para o responsável; quem não as tem continua sem poder trocar), as regras de estado da subtarefa e o limite de subtarefas. Entregar, aprovar e devolver subtarefa seguem como estavam.

**Consequência.**

- Nenhuma rota, tabela, migration ou permissão nova: só a tela, sobre as rotas que já existiam.
- Para o responsável e as subtarefas, a regra "esperar o salvar do formulário" da decisão de 2026-10-11 não se aplica: elas já não dependem do salvar geral do modal.

**Origem.** O dono, em 2026-11-04.

**Validação.** Pendente de validação do dono.
