# Modal do conteúdo na Pauta: faixa do pedido de ajuste sem autor nem citação e o que a artboard traz que fica de fora

**Data.** 2026-10-15

**Contexto.** A #633 redesenha o modal do conteúdo. A artboard "Modal" mostra, no conteúdo em ajuste, uma faixa com o nome de quem pediu, o tempo, a frase do pedido e um destaque na mídia citada; mostra também "3 de 3" na aba Atribuição, uma linha com o cliente, um menu "Mais ações", "Salvo há 5 s" no rodapé e a reordenação de mídia por arrastar. O detalhe do conteúdo (`ContentDetail`) não entrega o pedido de ajuste: o comentário do cliente é uma mensagem comum da conversa, sem marca, autor nem data no conteúdo. As demais peças da artboard seriam função nova, e o épico #621 proíbe função nova.

**Decisão.**
- A faixa do pedido de ajuste aparece só quando o estado é "Em ajuste" e diz o que o estado já garante (o cliente pediu ajuste e o pedido está na conversa), com o botão "Ver na conversa", que leva a rolagem e o foco à conversa. Não mostra nome, tempo nem citação, porque nenhum dado do conteúdo os entrega, e o último comentário da conversa não é lido como se fosse o pedido. A issue de API que entrega o pedido (#663: quem, quando, texto) fecha a faixa da artboard.
- A aba Atribuição fica sem o contador "3 de 3": o nome acessível da aba continua "Atribuição" (os testes e os leitores de tela dependem dele) e o andamento das subtarefas já está escrito dentro da aba.
- Ficam fora, por serem função nova ou dado que não existe: a linha do cliente sobre o título, o menu "Mais ações", o "Salvo há" (o modal salva pelo botão, não sozinho), o destaque da mídia citada e a reordenação por arrastar (a ordem segue pelas setas).
- O formato e o estado usam as mesmas duas etiquetas do card do calendário e a mesma tabela (imagem, vídeo longo e VSL no tom neutro; "Cancelado" com o ícone vazio de "Em produção" e a própria palavra), para o mesmo conteúdo ter a mesma cara no calendário e no modal.
- No rodapé, o único botão cheio é o movimento que leva o conteúdo adiante (enviar, aprovar, marcar como publicado, reagendar), e só enquanto não há nada a salvar; havendo mudança no formulário, o cheio é "Salvar" e os movimentos ficam em contorno. "Cancelar conteúdo" e "Desfazer publicação" nunca são cheios.

**Consequência.** Nenhuma rota, tabela ou permissão muda. Quem entregar o pedido de ajuste na API completa a faixa sem mudar a regra de estado. Um formato novo precisa de tom próprio na tabela de etiquetas.

**Origem.** Implementação da #633 (épico #621).

**Validação.** Pendente de validação do dono.
