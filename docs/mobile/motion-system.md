# Movimento na interface mobile

O mobile web usa o Motion já instalado para manter continuidade na seleção. O fluxo, a resposta da API e a seleção acessível mudam imediatamente; a animação acompanha a mudança, sem bloquear a próxima ação.

## Implementado

- Calendário: uma superfície contínua usa molas independentes para frente e cauda. O atraso entre elas deforma a seleção com limites de 65% na horizontal e 35% na vertical. Uma cópia decorativa recortada dos números mantém o contraste durante o trajeto; não recebe foco nem aparece na árvore acessível.
- Abas e navegação inferior: o mesmo indicador usa medidas reais dos controles. Seleção e foco não dependem do término da mola. Setas, Home e End navegam pelas abas.
- Seletores e confirmação de saída do editor: o Modal original mantém contenção e retorno de foco. Superfície e fundo animam separadamente; o fechamento conserva a montagem até a saída e torna o conteúdo inerte. Reabrir cancela o fechamento anterior.
- Listagem de conteúdos: chaves estáveis mantêm identidade durante reposicionamento. Linhas em saída ficam inertes. A lista permanece montada quando o último item sai.
- Filtros: expansão e contração do agrupamento; altura animada é uma exceção local de disclosure, não um padrão para outros componentes.
- Formulários: foco destaca a borda sem mover campos; callbacks, valores e referências são preservados. Transições interrompidas de tela retomam a transformação exibida, sem remontar os campos.

## Tokens e limites

`apps/mobile/src/product/motion/tokens.ts` conserva os tempos 120/180/240 ms e a curva do design system. As molas acrescentam continuidade física à seleção conforme a direção solicitada para o mobile; não substituem as regras da Pauta desktop. A mola de frente usa rigidez 600, amortecimento 38 e massa 0,8; a cauda, 380/34/1.

Medir apenas no layout, mudança de mês ou redimensionamento. Não usar estado React por frame. Sem filtros SVG, blur ou sombras animadas. O recorte dos números exige pintura: não presumir que toda a composição seja acelerada nem prometer 60 FPS sem medição em aparelho.

`prefers-reduced-motion` assenta os indicadores imediatamente, remove deslocamentos e conclui saídas pendentes. Nenhuma informação depende do movimento. Mudanças de tamanho e mês assentam a seleção para evitar atravessar uma grade obsoleta.

O comportamento líquido e a animação de lista são específicos da web. Android/iOS conservam seleção estática e os controles nativos existentes; exportar os bundles não equivale a validar fisicamente os aparelhos.

## Verificação

Testar seleção adjacente, distante e diagonal, interrupção por nova seleção, redimensionamento, teclado, fechamento/reabertura de seletor, retorno de foco e mudança de movimento reduzido durante uma animação. Preservar os testes de identidade de formulário e as chamadas funcionais existentes.

As skills instaladas `animate`, `animate-expo` e `animation-performance` já cobrem construção, plataforma e custo de renderização; não foi adicionada outra biblioteca nem uma skill redundante.
