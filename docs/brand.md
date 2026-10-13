# Marca: logo, símbolo e mascote

Onde estão o logo, o símbolo e o mascote do Ageniza, e quando usar cada um. As cores, a tipografia e os componentes ficam no [design system](design-system.md); este documento cuida só das peças de marca.

## O que existe hoje

As seis imagens abaixo são os **originais de referência** (reduzidas a 1200 px de largura; os arquivos em resolução cheia ficam no Figma, página Originais), gerados em 2026-10-13 e aprovados pelo dono do produto como a identidade da marca. São JPG com fundo e, em duas delas, efeito de maquete 3D: servem para conhecer a forma e as cores, **não para entrar no app como estão**. As versões de produção estão em "Para usar no produto", abaixo, e saem do arquivo do Figma.

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

## Para usar no produto

A fonte das peças é o arquivo do Figma **[Ageniza — Marca](https://www.figma.com/design/1sXePa6OxcpGufouSRpSP7)**: o símbolo foi vetorizado a partir de `simbolo-mono-fundo-claro.jpg`, o logo foi montado com a palavra em texto real (Montserrat Bold, a assinatura em Montserrat Medium com espaçamento de 14%) e as cores são variáveis do Figma com os mesmos nomes e valores dos tokens (`--color-indigo-600`, `--color-violet-600`, `--color-teal-500`, `--color-ink-900`, `--color-white`). Toda mudança na marca acontece lá e é exportada para cá; não edite os arquivos abaixo à mão.

Os arquivos de produção ficam em [`apps/web/public/brand/`](../apps/web/public/brand/) e são servidos em `/brand/<arquivo>`:

| arquivo | o que é | onde usar |
|---|---|---|
| `logo-para-fundo-claro.svg` | logo completo, símbolo em degradê e texto em ink | sobre fundo claro: login, e-mail, documentos |
| `logo-para-fundo-escuro.svg` | logo completo, símbolo em degradê e texto em branco | sobre fundo escuro |
| `logo-mono-ink.svg` / `logo-mono-branco.svg` | logo completo em uma cor (ink / branco) | impressão e situações de uma cor só |
| `simbolo-colorido.svg` | símbolo em degradê violeta → índigo → teal | tamanho grande (48 px ou mais) |
| `simbolo-ink.svg` / `simbolo-branco.svg` | símbolo chapado em ink (para fundo claro) / branco (para fundo escuro) | interface pequena: navegação, avatar da conta Ageniza |
| `icone-16.png`, `icone-32.png` | símbolo em ink, fundo transparente | favicon |
| `icone-180.png`, `icone-512.png` | símbolo colorido sobre quadrado ink de cantos arredondados | ícone do app (Apple touch, PWA) |
| `mascote-amigavel.webp` (+ `@2x.webp`, + `.png`) | mascote de corpo inteiro, sem fundo, 480 px de altura (960 no @2x) | estados vazios, boas-vindas, convite |
| `mascote-serio.webp` (+ `@2x.webp`, + `.png`) | mascote em busto, sem fundo, 480 px de altura (960 no @2x) | 404, erro, agência suspensa, sessão encerrada |

Use o WebP, com `srcset` para o @2x. O PNG (só 1x) fica para e-mail, onde WebP não é garantido. Nos nomes, `para-fundo-claro`/`para-fundo-escuro` diz onde a peça vai; `ink`/`branco` diz a cor da peça.

Ainda não ligado no app: o favicon do `index.html` e o uso de cada peça nas telas entram nas tasks do redesign.
