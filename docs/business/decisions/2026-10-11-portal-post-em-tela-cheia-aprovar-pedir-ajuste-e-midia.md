# Portal: o post em tela cheia aprova de um toque, recarrega ao conflito e desenha a mídia pelo tipo que a API informa

**Data.** 2026-10-11

**Contexto.** A tela `/portal/:clienteId/conteudos/:conteudoId` (issue #270) é a primeira que usa as rotas de aprovação do portal (#257) e a de mídia (#584). A SPEC de Conteúdo (seção 7) diz "post em tela cheia, Aprovar, Pedir ajuste e a conversa", mas não fixa o que acontece quando a agência mexe no post enquanto a pessoa o lê, nem como a tela sabe se um item da mídia é imagem ou vídeo, nem para onde o link de volta aponta enquanto a lista (#269) não existe.

**Decisão.**
1. **Aprovar é um toque, sem diálogo de confirmação.** A tela manda a `revision` que leu. Se a API responde `409 CONTENT_REVISION_CHANGED` (a agência mudou legenda, mídia, capa ou formato depois da leitura) ou `409 CONTENT_NOT_AWAITING_APPROVAL` (o estado mudou), a tela diz o que aconteceu com um texto próprio para cada caso, lê o post de novo e **segura os dois botões até a leitura terminar**, para que o clique seguinte nunca leve uma revisão já substituída. Aprovar e pedir ajuste de um conteúdo cancelado nesse meio-tempo cai no "não encontrado", como o 404 da API.
2. **Pedir ajuste abre uma caixa com o comentário obrigatório.** Comentário vazio, só de espaços ou de caracteres invisíveis, com caractere não aceito ou acima de 5.000 bytes não chega à API: a tela pergunta ao próprio `CommentBodySchema` e só escolhe o texto da resposta. O que foi digitado fica quando o envio falha e quando a caixa é fechada sem enviar; some só quando o pedido é gravado.
3. **A conversa do conteúdo aparece de "aguardando aprovação" em diante** (também em ajuste, aprovado e publicado), no lado cliente, com o componente de conversa que já serve ao estudo de marca. O pedido de ajuste entra nela como primeira mensagem; a tela a relê ao gravar. Em produção não há conversa nem mídia nem legenda, só título, dia e formato, como a API responde.
4. **O tipo de cada item vem da API.** Cada item de `media[]` traz `kind` (`image` ou `video`, `2026-10-11-portal-media-do-post-diz-se-e-imagem-ou-video`), e a tela desenha `<img>` ou `<video>` por ele, sem adivinhar. A capa e as miniaturas pedem sempre `variant=thumbnail`; o slide pede o original. Nos formatos de vídeo o pôster é a capa do conteúdo e, sem capa, o quadro do próprio vídeo; num vídeo de carrossel é sempre o quadro dele (a capa é dos formatos de vídeo). Enquanto o quadro não está pronto (`409 VARIANT_NOT_READY`) o vídeo toca sem pôster.
5. **O link de volta leva a `/portal/:clienteId/conteudos`**, o endereço da lista do portal (#269). Enquanto a lista não existe, esse endereço é o "não encontrado" do portal.

**Consequência.**
- Sem diálogo de confirmação, um toque errado em Aprovar aprova. O portal não tem "desaprovar": quem aprovou sem querer pede à agência, que pode reabrir o conteúdo ao mudar legenda ou mídia (regra 6 da SPEC). Se o dono quiser confirmação, é um diálogo na tela, sem mudança de API.
- Aprovar ou pedir ajuste em vários toques seguidos envia um pedido só: a tela guarda um sinal de envio em andamento, porque o estado de "pendente" da mutação chega ao botão um instante depois do clique.

**Origem.** Issue #270 e o pedido do Cardume para a tela do portal; o item 1 é decisão do implementador, tomada aqui por não estar na SPEC nem na issue; o item 4 segue a decisão do maestro no PR #600.

**Validação.** Pendente de validação do dono.
