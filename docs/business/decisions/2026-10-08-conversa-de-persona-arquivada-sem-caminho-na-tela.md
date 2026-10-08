# A conversa de uma persona arquivada não tem caminho na tela da agência

**Data.** 2026-10-08

**Contexto.** A SPEC (`specs/clientes.md`, seção 7) diz que as conversas de uma persona arquivada ficam somente leitura, e a issue #142 repete isso na tabela de variação. Mas a aba Estudo de marca (#138) mostra a persona arquivada só como uma linha com **Desarquivar**: ela não abre o diálogo da persona, que é onde mora a conversa dela. A SPEC não diz por onde a agência lê essa conversa.

**Decisão.** Nesta entrega a conversa de uma persona arquivada não é aberta pela tela. O componente de conversa já aceita `readOnly` para esse caso, e o diálogo da persona o liga quando a persona está arquivada, mas nenhum caminho da interface chega lá. Desarquivar devolve a persona, e a conversa volta a ser escrita.

**Consequência.** Quem quiser reler a conversa de uma persona arquivada precisa desarquivá-la antes. Se o dono quiser leitura sem desarquivar, o passo é abrir o diálogo da persona arquivada em modo somente leitura, o que muda a aba Estudo de marca e não o componente.

**Origem.** Issue #142, revisão do PR #413 (achado 12); `specs/clientes.md`, seção 7.

**Validação.** Pendente de validação do dono.
