# Marca: logo, símbolo e mascote

Onde estão o logo, o símbolo e o mascote do Ageniza, e quando usar cada um. As cores, a tipografia e os componentes ficam no [design system](design-system.md); este documento cuida só das peças de marca.

## O que existe hoje

As seis imagens abaixo são os **originais de referência**, gerados em 2026-10-13 e aprovados pelo dono do produto como a identidade da marca. São JPG com fundo e, em duas delas, efeito de maquete 3D: servem para conhecer a forma e as cores, **não para entrar no app como estão**. As versões de produção estão em "Para usar no produto", abaixo.

| arquivo | o que é |
|---|---|
| [`brand/originais/logo-completo-fundo-claro.jpg`](brand/originais/logo-completo-fundo-claro.jpg) | Logo completo: o símbolo da coruja em degradê (índigo, violeta e teal), a palavra "Ageniza" em tinta escura e a assinatura "ESTRATÉGIA · ORGANIZA · RESULTADOS". Sobre fundo claro. |
| [`brand/originais/logo-completo-fundo-escuro.jpg`](brand/originais/logo-completo-fundo-escuro.jpg) | O mesmo logo sobre fundo escuro, em maquete 3D, com a palavra em degradê. Referência de apresentação e marketing. |
| [`brand/originais/simbolo-mono-fundo-claro.jpg`](brand/originais/simbolo-mono-fundo-claro.jpg) | Só o símbolo, em uma cor (tinta escura), sobre fundo claro. |
| [`brand/originais/simbolo-mono-fundo-escuro.jpg`](brand/originais/simbolo-mono-fundo-escuro.jpg) | Só o símbolo, em uma cor (prata), sobre fundo escuro, em maquete 3D. |
| [`brand/originais/mascote-amigavel.jpg`](brand/originais/mascote-amigavel.jpg) | O mascote: coruja 3D de corpo inteiro, olhos grandes e expressão acolhedora, nas cores da marca. |
| [`brand/originais/mascote-serio.jpg`](brand/originais/mascote-serio.jpg) | O mascote em versão séria: coruja 3D de olhar firme, só o busto. |

O símbolo é uma coruja de frente dentro de um círculo aberto, com duas "órbitas" terminadas em ponto. A coruja é a mesma no logo, no símbolo e no mascote.

## Quando usar cada peça

| peça | onde | por quê |
|---|---|---|
| Logo completo | tela de login, cabeçalho de e-mail, documentos (termos, privacidade), página pública | é onde a marca se apresenta por inteiro e há espaço |
| Símbolo | favicon, ícone do app, canto da navegação lateral, avatar da conta "Ageniza" em notificações | precisa caber em 16 a 48 px; o logo completo não lê nesse tamanho |
| Mascote amigável | estado vazio com ação (primeiro cliente, primeiro conteúdo, nada para aprovar), boas-vindas, e-mail de convite | acolhe sem ocupar o lugar da ação: a ação primária continua sendo o botão |
| Mascote sério | página 404 e erro inesperado, aviso de atenção (agência suspensa, sessão encerrada) | dá um rosto ao problema sem dramatizar; a mensagem diz o que aconteceu e como sair |

Regras propostas, a confirmar na fundação do redesign:

- O mascote aparece **no máximo uma vez por tela**, e nunca em tela de trabalho cheia (calendário com conteúdo, modal, formulário): só em vazio, boas-vindas e erro.
- Na interface, o símbolo pequeno é **chapado, em uma cor** (o token de texto ou de ação primária do tema). O degradê fica para o logo completo em tamanho grande.
- O efeito de maquete 3D (relevo, luz, sombra de parede) dos originais **nunca entra no app**.
- O degradê do logo usa as cores da paleta do projeto (índigo, violeta, teal); nenhuma cor nova entra por causa da marca.
- O portal do cliente mostra a marca da agência e do cliente em primeiro lugar; o Ageniza aparece discreto (símbolo no rodapé ou no login).

## Para usar no produto (pendente)

Antes de qualquer tela usar a marca, ela precisa existir em formato de produção. É a primeira task do goal de redesign:

- logo completo e símbolo **vetorizados em SVG**, com fundo transparente, nas cores exatas dos tokens, nas versões: colorido, uma cor clara e uma cor escura;
- favicon e ícones do app gerados a partir do símbolo (16, 32, 180 e 512 px);
- os dois mascotes em **PNG ou WebP com fundo transparente**, recortados, em 1x e 2x;
- tudo em `apps/web/public/brand/`, com a lista de arquivos atualizada nesta página.

Até lá, os originais desta pasta são a referência, e nenhuma tela usa os JPG diretamente.
