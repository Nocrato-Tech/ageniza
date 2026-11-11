# O Início do portal segue o quadro (três capas e "Boa notícia" com progresso), e a conversa continua no post

**Data.** 2026-11-11

**Contexto.** O Início do portal mostra duas capas, o roteiro de stories de hoje e "Nesta semana" ([`2026-10-11-portal-inicio-aprovacoes-e-roteiro-de-hoje`](2026-10-11-portal-inicio-aprovacoes-e-roteiro-de-hoje.md); `specs/conteudo.md`, seção 7; `specs/clientes.md`, "Portal: Início"). O quadro do redesenho (r0) tem a data e "Olá, Rosana", um subtítulo, **três** capas de post com "Aguardando você" ou "Atrasado", "Responda até quinta, 12 nov, 18h", o botão "Revisar os 3 posts" ("Começamos pelo que vence primeiro"), "A agência pediu" e, quando nada espera, o bloco **"Boa notícia"** ("Seu feed de novembro já está 70% aprovado", "7 de 10", "vai ao ar hoje às 18h"). O post do quadro não mostra a conversa.

**Decisão.**

1. **Início.** Data e "Olá, <nome>"; subtítulo que diz o que a agência espera ("A <agência> espera N respostas suas"); até **três capas** dos posts que esperam, com "Aguardando você" ou "Atrasado" (a data de publicação já passou) e "Responda até <dia>, <hora>" (o prazo de aprovação, com hora); "Revisar os N posts", que abre o que **vence primeiro** e encadeia o próximo; e "A agência pediu".
2. **"Boa notícia".** Quando **nada espera a aprovação**, o Início mostra o progresso do mês: "Seu feed de <mês> já está N% aprovado", "N de M" e o próximo post que vai ao ar ("hoje às 18h: <título>"), com o link "Ver o que vai ao ar esta semana". **M** são os conteúdos do mês que não foram cancelados; **N**, os aprovados e publicados. O mascote e a barra de progresso são do palco, um só por bloco.
3. **Sai "Nesta semana"; o roteiro de hoje fica.** O Início não mostra mais "Nesta semana". O **"Roteiro de hoje" continua**, como um bloco compacto **abaixo do quadro**, com o botão **"Já gravei"**, e só existe quando há roteiro enviado ou gravado do dia de São Paulo (sem roteiro, o bloco não aparece, como já era). Tirar o "Já gravei" seria perda de função, porque é como o cliente diz à agência que gravou o roteiro enviado. As regras do bloco são as de [`2026-10-11-portal-inicio-aprovacoes-e-roteiro-de-hoje`](2026-10-11-portal-inicio-aprovacoes-e-roteiro-de-hoje.md): cenas em ordem (texto e "Orientação"), roteiro em rascunho nunca aparece, "Gravado por <nome> em dd/mm" depois de marcado, e o erro do bloco não derruba o resto do Início. O quadro não o mostra; ele entra **além** do quadro, do mesmo jeito que a conversa continua no post (item 4).
4. **A conversa continua no post**, recolhida abaixo dele, mesmo que o quadro não a mostre. Ali o cliente vê as respostas da agência e o recado que ele mesmo deu ao aprovar. Vale a regra de sempre: o portal só comenta a partir de "aguardando aprovação".
5. **O post** ganha a trilha "Início > título", a etiqueta grande "Aguardando sua aprovação", "Carrossel · 5 imagens · publica na sexta, 13 nov, às 12h", o painel "Sua resposta" com "Responda até <dia>, <hora> · Falta 1 dia", o recado da agência com o remetente e o campo "Seu recado para a agência" (ver [`2026-11-11-estrutural-a-rodada-de-aprovacao-mostra-ao-cliente-quem-enviou-e-aceita-recado-ao-aprovar`](2026-11-11-estrutural-a-rodada-de-aprovacao-mostra-ao-cliente-quem-enviou-e-aceita-recado-ao-aprovar.md)). "Aprovar o post" é a ação principal do painel e "Pedir ajuste" a secundária; no celular, a barra de ação fica fixa. A legenda "Ao aprovar, a agência agenda a publicação" **não** entra: a plataforma não agenda nada; o texto diz o que de fato acontece ("Ao aprovar, a agência é avisada e cuida da publicação"), sem prometer publicação automática.
6. **Navegação do portal** e o rótulo "Com a <agência>" são os de [`2026-11-11-o-perfil-do-cliente-tem-cinco-abas-e-a-aba-conteudos-volta`](2026-11-11-o-perfil-do-cliente-tem-cinco-abas-e-a-aba-conteudos-volta.md) e do [`o-visual-segue-o-quadro-r0`](2026-11-11-o-visual-segue-o-quadro-r0-semana-no-domingo-capa-no-card-e-uma-primaria-por-bloco.md).

**Substitui.**

- A [`2026-10-11-portal-inicio-aprovacoes-e-roteiro-de-hoje`](2026-10-11-portal-inicio-aprovacoes-e-roteiro-de-hoje.md) só no que o Início tinha **acima** do roteiro (a pendência continua antes de tudo, e o resto do Início segue o quadro) e no bloco "Nesta semana". O **roteiro de hoje e o "Já gravei" dessa decisão continuam**, agora abaixo do quadro.
- A linha "Nesta semana" de `specs/conteudo.md` (seção 7), as "duas capas" de `specs/clientes.md` (seção 7, "Portal: Início") e a frase "o post inclui a conversa em tela cheia, Aprovar, Pedir ajuste, conversa" no que o portal passa a ter a conversa recolhida.

**Consequência.**

- Só a tela e a leitura mudam, sem tabela nova: o Início passa a precisar de aprovados e total do mês (leitura do portal, sob a RLS que já vale) e do próximo post a ir ao ar (aprovado com data e hora).
- O dado do portal continua sem subtarefa, responsável nem prazo interno. A hora de publicação já chega ao portal.
- O fluxo mobile do portal descreve o Início (com o roteiro de hoje abaixo do quadro) e o post.

**Origem.** Pedido do dono do produto em 2026-11-11 ("quero exatamente tudo igual ao quadro"), resposta dele de que a conversa continua no post e decisão do maestro sobre a "Boa notícia" (riscos 15 e 18 do inventário).

**Validação.** Pendente de validação do dono.
