# ESTRUTURAL: a agência tem notificações dentro do app, com cinco eventos, lida e não lida

**Data.** 2026-11-11

**Contexto.** O quadro do redesenho (r0) tem um sino com ponto na barra superior da agência. Hoje nada notifica dentro do produto: `specs/conteudo.md` (seção 10) adia "notificação dentro do produto" até o segundo tipo de notificação entrar na fila, e `specs/clientes.md` (seções 8 e 10) diz "nenhum e-mail novo" e "notificação fora". A decisão [`2026-09-26-o-portal-nasce-com-navegacao-de-celular-tour-do-que`](2026-09-26-o-portal-nasce-com-navegacao-de-celular-tour-do-que.md) deixou o portal sem notificação.

**Decisão.**

1. **Só dentro do app, só para a agência.** Há um sino com ponto (quando há não lidas) e uma lista, para as pessoas da agência. Não há e-mail novo, push nem WhatsApp. O portal não tem notificações.
2. **Cinco eventos**, todos de coisas que já acontecem:
   - **o cliente aprovou** um conteúdo (inclusive com recado);
   - **o cliente pediu ajuste** em um conteúdo;
   - **o cliente respondeu um pedido de material** (comentário ou arquivo enviado);
   - **venceu o prazo de aprovação** de um conteúdo que ainda aguarda;
   - **um convite foi aceito** (de colaborador ou do portal).
3. **Quem recebe.** Os três primeiros e o de prazo vão para o **responsável do conteúdo** (o do pedido de material, para quem abriu o pedido); o convite aceito, para quem o enviou. Só recebe quem **ainda pode ler** aquilo: sem `conteudo.visualizar` (ou `cliente.visualizar` no pedido de material, `colaborador.visualizar` no convite de colaborador), a notificação não aparece, e o título do conteúdo não vaza.
4. **Lida e não lida.** Cada notificação é da pessoa: ela marca como lida ao abrir, ou "marcar todas como lidas". Não há apagar nem preferências por tipo. A notificação leva ao que aconteceu (o conteúdo, o pedido, a equipe).
5. **O que guarda.** O tipo, o conteúdo ou o pedido a que se refere, o texto curto de quando aconteceu e a data. Nenhum corpo de recado ou comentário além de um trecho curto.
6. **"Reenviar o link", "Cobrar o cliente" e o aviso de WhatsApp só compartilham.** Não há envio novo: as ações abrem o compartilhamento do endereço de entrada do portal (a mesma regra de [`2026-11-10-compartilhar-o-acesso-ao-portal-por-link-e-whatsapp`](2026-11-10-compartilhar-o-acesso-ao-portal-por-link-e-whatsapp.md)) com uma mensagem pronta, e a tela nunca diz que o cliente "recebe no WhatsApp". O e-mail de envio, os dois lembretes e o e-mail de boas-vindas continuam como são.

**Substitui.**

- O ponto "Preferências de notificação e notificação dentro do produto" da seção 10 de `specs/conteudo.md` (o gatilho foi atendido por esta decisão; preferências por tipo continuam em aberto).
- A frase "notificação está fora" da seção 8 e a linha "Notificação — e-mail ou push — de conversa e de aprovação, com estado de lido" da seção 10 de `specs/clientes.md`, no que cobre a agência dentro do app; e-mail ou push continuam fora.
- Em [`2026-09-26-o-portal-nasce-com-navegacao-de-celular-tour-do-que`](2026-09-26-o-portal-nasce-com-navegacao-de-celular-tour-do-que.md), só no que diz respeito ao app da agência: o portal continua sem notificação.

**Consequência.**

- **É estrutural:** módulo novo (`notifications`) com tabela nova e RLS por pessoa, criada por funções `security definer` de escopo único chamadas nas transações dos eventos (aprovar, pedir ajuste, responder pedido, aceitar convite) e por um trabalho diário do worker para o prazo vencido, na forma de "Trabalho agendado sem requisição" de [`structural-changes.md`](../structural-changes.md). Nenhuma tabela existente muda.
- **Risco: Alto.** Banco, RLS e dado de pessoa (o título de um conteúdo de um cliente a quem não pode lê-lo). Pede revisão de segurança independente; a SPEC é `specs/notificacoes.md`.
- O fluxo mobile da agência descreve o sino e a lista. O app nativo ganha a mesma lista pela mesma API.

**Origem.** Resposta do dono do produto em 2026-11-11 (notificações só dentro do app, com lida e não lida, para os cinco eventos) e decisão do maestro sobre quem recebe e sobre as ações de compartilhar.

**Validação.** Pendente de validação do dono.
