# No post do portal, a barra de decisão toma o lugar das quatro abas no celular

**Data.** 2026-10-15

**Contexto.** A SPEC de clientes (seção 7) desenha o portal com uma barra inferior de quatro itens, e a SPEC de conteúdo chama o post de "em tela cheia" com **Aprovar** e **Pedir ajuste**. A artboard **Portal · Post** do canvas de redesign (épico #685, issue #687) desenha o post sem a barra de abas: um link de volta no topo e, no pé, uma barra fixa com os dois botões. Uma barra de abas e uma barra de decisão, as duas coladas no pé de um celular, tomariam a altura de duas barras e deixariam o botão de aprovar entre os itens de navegação.

**Decisão.**
1. No celular (abaixo de 48 rem), enquanto o post está aberto, as quatro abas do portal somem e o caminho de volta é o link "Conteúdos" no topo do post. O link existe em todos os estados da tela: carregando, erro, em produção, aguardando aprovação, em ajuste, aprovado e publicado.
2. Com o tour de boas-vindas aberto as abas voltam, porque o tour aponta para elas.
3. Em tela larga as abas continuam no topo, como nas demais telas do portal.
4. A barra de decisão só existe com o conteúdo aguardando aprovação. Pedir ajuste fica à esquerda e Aprovar, a única ação em índigo cheio da tela, à direita. A barra é o último pedaço da página, para o fim da conversa nunca ficar por baixo dela.
5. Da artboard ficam de fora o texto "Esperando você" (o estado segue "Aguardando aprovação", que a SPEC e as decisões anteriores fixam) e o "1 de 2 para aprovar" (a API do post não entrega a posição na fila).

**Consequência.** A frase da SPEC de clientes sobre a barra inferior ganha a exceção do post, e a SPEC de conteúdo passa a descrever a barra de decisão. Quem quiser as abas junto da barra de decisão desfaz o item 1, que é um bloco de CSS do post, sem mudança de rota, API ou banco.

**Origem.** Épico #685, issue #687; artboard Portal · Post do canvas de redesign; pedido de confirmação ao dono na entrega do PR #692.

**Validação.** Pendente de validação do dono.
