# Movimento na interface mobile

O mobile web usa o Motion já instalado para manter continuidade na seleção. O fluxo, a resposta da API e a seleção acessível mudam imediatamente; a animação acompanha a mudança, sem bloquear a próxima ação.

## Implementado

- Calendário: uma superfície contínua usa molas independentes para frente e cauda. O atraso entre elas deforma a seleção com limites de 65% na horizontal e 35% na vertical. Uma cópia decorativa recortada dos números mantém o contraste durante o trajeto; não recebe foco nem aparece na árvore acessível.
- Meses: grade e título atravessam a janela na direção de avanço ou retorno. Os botões permanecem montados. A grade anterior fica inerte e oculta da árvore acessível durante a saída; inverter a direção retoma o painel ainda presente.
- Abas e navegação inferior: o mesmo indicador usa medidas reais dos controles. Seleção e foco não dependem do término da mola. Setas, Home e End navegam pelas abas.
- Seletores e confirmação de saída do editor: o Modal original mantém contenção e retorno de foco. Superfície e fundo animam separadamente; o fechamento conserva a montagem até a saída e torna o conteúdo inerte. Reabrir cancela o fechamento anterior.
- Listagem de conteúdos: chaves estáveis mantêm identidade durante reposicionamento. Linhas em saída ficam inertes. A lista permanece montada quando o último item sai.
- Filtros: expansão e contração do agrupamento; altura animada é uma exceção local de disclosure, não um padrão para outros componentes.
- Formulários: foco destaca a borda sem mover campos; callbacks, valores e referências são preservados. Transições interrompidas de tela retomam a transformação exibida, sem remontar os campos.
- Pressão: botões de ação e da casca, seleção de cliente, troca de contexto, conta e visibilidade de senha compartilham `Touch`. Botões ocupados mantêm rótulo e espaço do indicador, sem saltos de alinhamento. Abas usam o indicador próprio.

## Tokens e limites

`apps/mobile/src/product/motion/tokens.ts` conserva os tempos 120/180/240 ms e a curva do design system. As molas acrescentam continuidade física à seleção conforme a direção solicitada para o mobile; não substituem as regras da Pauta desktop. A mola de frente usa rigidez 600, amortecimento 38 e massa 0,8; a cauda, 380/34/1.

Medir apenas no layout, mudança de mês ou redimensionamento. Não usar estado React por frame. Sem filtros SVG, blur ou sombras animadas. O recorte dos números exige pintura: não presumir que toda a composição seja acelerada nem prometer 60 FPS sem medição em aparelho.

`prefers-reduced-motion` assenta os indicadores imediatamente, remove deslocamentos e conclui saídas pendentes. Nenhuma informação depende do movimento. Mudanças de tamanho e mês assentam a seleção para evitar atravessar uma grade obsoleta.

O comportamento líquido e a animação de lista são específicos da web. Android/iOS conservam seleção estática e os controles nativos existentes; exportar os bundles não equivale a validar fisicamente os aparelhos.

## Verificação

Testar seleção adjacente, distante e diagonal, interrupção por nova seleção, redimensionamento, teclado, fechamento/reabertura de seletor, retorno de foco e mudança de movimento reduzido durante uma animação. Preservar os testes de identidade de formulário e as chamadas funcionais existentes.

As skills instaladas `animate`, `animate-expo` e `animation-performance` já cobrem construção, plataforma e custo de renderização; não foi adicionada outra biblioteca nem uma skill redundante.

## Cobertura dos fluxos de trabalho

- Início, clientes e conteúdos usam chegada espacial direcional de 28px/240ms; trocar filtros de cliente e lista/kanban atualiza a identidade da transição. Interromper uma navegação retoma a transformação exibida.
- O anel de cliente viaja entre avatares. Os rótulos e o estado selecionado mudam imediatamente; grupos independentes não compartilham a seleção.
- Edição de cadastro, marca e personas, cancelamento, conversas e confirmação de arquivamento usam disclosure com saída inerte. Digitar não reinicia a chegada nem remonta o campo.
- Equipe, convites, tarefas, comentários e mídias selecionadas usam chaves estáveis para inserção, remoção e reposicionamento. O estado assíncrono continua governado pela resposta real da API.
- O progresso do editor usa escala com mola. A biblioteca mostra miniaturas antes da seleção; abrir/fechar prévias e análise do conteúdo conserva uma saída visível.
- Data proposta, prazo de tarefa, encerramento de cliente e roteiro usam o mesmo seletor próprio na web. Calendário com seleção líquida, troca de mês direcional e teclado; horário com colunas de horas/minutos e atalhos. Alterações ficam locais até confirmar; cancelar restaura o valor anterior. Não existem inputs web date/time nesses fluxos.
- O foco do formulário desloca somente o rótulo em 2px e muda sua cor. O texto digitado e o placeholder não ficam se movendo durante a leitura. Movimento reduzido remove o deslocamento.

A validação automatizada cobre cancelamento, teclado, datas inválidas, formato ISO enviado à API, permissões somente leitura e identidade dos campos. A verificação em navegador complementa esses testes; exportação não prova desempenho em um aparelho físico.

## Polimento de estabilidade

A seleção da equipe permanece montada enquanto os dados da aba são consultados. Variações de arredondamento de até 1px entre células não reiniciam a seleção líquida. Filtros de cliente e lista/kanban não fazem parte da identidade de chegada da página: o cabeçalho e a faixa de clientes ficam imóveis.

No estudo de marca, leitura e edição compartilham uma troca de estado com a saída sobreposta e recortada, evitando duas alturas expandidas ao mesmo tempo. Conteúdo em saída fica inerte. A paleta oferece amostras, hexadecimal e canais RGB; inclusão e retirada conservam chaves locais estáveis. Identidade, tom de voz e posicionamento usam campos guiados gravados como texto legível no contrato existente, sem migração de dados nem descarte de conteúdo anterior. Arquétipos usam escolhas visuais com rótulos e navegação por teclado. Campos vazios não contam como seção preenchida só por conter títulos.
