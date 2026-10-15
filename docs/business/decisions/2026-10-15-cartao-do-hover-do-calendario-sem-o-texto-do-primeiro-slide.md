# Cartão do hover do calendário: sem o texto do 1º slide, e a dica de arrastar só onde se arrasta

**Data.** 2026-10-15

**Contexto.** O pedido do dono para o cartão flutuante do calendário (issue #632, épico #621) lista a prévia da mídia, o título completo, data e rede, o trecho da legenda e do texto do primeiro slide, as duas etiquetas e a dica "arraste para outro dia". A API não entrega o texto de nenhum slide: o detalhe do conteúdo traz `caption`, `media` (só id e posição) e as subtarefas. A issue manda, para o dado que a API não entrega, abrir a issue de API e entregar a tela sem o bloco. A dica de arrastar, por sua vez, é verdadeira só para o card que a pessoa pode mover (permissão de operar, conteúdo ainda aberto, nenhum outro card em movimento).

**Decisão.**
1. O cartão do hover não mostra o texto do 1º slide até a API entregá-lo; o bloco entra quando a rota existir, sem outra decisão.
2. "Arraste para outro dia" aparece só no cartão de um conteúdo que pode ser arrastado; num publicado, cancelado ou sem permissão de operar, a dica seria falsa e não aparece.
3. O cartão mantém as linhas que o hover já tinha (responsável, subtarefas, conversa e última mensagem), porque a SPEC de conteúdo (seção 7) as pede e nada nesta tela as revoga.

**Consequência.** A tela de hoje entrega tudo o que a API sustenta. O texto do slide é a issue de API #667; sem ela, o cartão do carrossel mostra a legenda, como o de qualquer outro formato.

**Origem.** Issue #632, épico #621; pedido do dono de 2026-10-13 (cartão flutuante do calendário).

**Validação.** Pendente de validação do dono.
