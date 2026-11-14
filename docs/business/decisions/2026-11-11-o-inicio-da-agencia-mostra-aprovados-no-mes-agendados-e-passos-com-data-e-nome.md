# O Início da agência mostra "Aprovados no mês" (com comparação), "Agendados", e a jornada com data e nome em cada passo

**Data.** 2026-11-11

**Contexto.** O Início da agência tem a jornada "Até a primeira aprovação" só com feito e pendente, "Parado no cliente", e atalhos de módulo ([`2026-11-10-jornada-ate-a-primeira-aprovacao`](2026-11-10-jornada-ate-a-primeira-aprovacao.md); [`2026-11-06-caminho-de-ativacao-e-marcos-da-agencia`](2026-11-06-caminho-de-ativacao-e-marcos-da-agencia.md)). O quadro do redesenho (r0) tem o botão "Novo conteúdo", os blocos Esperando, Atrasados, **Aprovados no mês** ("12, 3 a mais que em outubro") e **Agendados** ("6, programados até dia 20"), e a jornada com "Feito", o nome e a data de cada passo.

**Decisão.**

1. **Aprovados no mês.** Conta os conteúdos aprovados **no mês corrente** (aprovados ou publicados, pelo dia da aprovação em São Paulo; a aprovação fora da plataforma também conta, como aprovação da agência) e compara com o **mês anterior** ("3 a mais que em outubro", "3 a menos", "igual"). A comparação é a contagem de hoje de cada mês: não é um histórico. A ação é "Agendar os aprovados", que leva ao calendário filtrado em Aprovado (os que ainda estão sem hora).
2. **Agendados.** Conta os conteúdos agendados ([`2026-11-11-agendado-e-um-estado-derivado-de-aprovado-com-data-e-hora-futuras`](2026-11-11-agendado-e-um-estado-derivado-de-aprovado-com-data-e-hora-futuras.md)) e diz "programados até dia N", a data do último. A ação é "Abrir o calendário". Nunca diz "saem sozinhos".
3. **Esperando e Atrasados** seguem as regras de [`2026-11-11-atrasado-conta-pela-data-de-publicacao-e-parado-no-cliente-segue-a-ordem-de-envio`](2026-11-11-atrasado-conta-pela-data-de-publicacao-e-parado-no-cliente-segue-a-ordem-de-envio.md); "Esperando" leva a "Parado no cliente" ("Ver quem está parado").
4. **Passos com data e nome.** Cada passo feito mostra "Feito", **o nome e a data**: o primeiro cliente ("Padaria Central · 3 de novembro"); o primeiro conteúdo; o primeiro envio ("Enviado a Rosana Teixeira · 9 de novembro"), com o nome da pessoa ativa do portal do cliente (a primeira, e "e mais N"; sem pessoa conhecida, o nome do cliente); e a primeira aprovação ("Aprovado por Rosana Teixeira · agora"), com o nome de **quem aprovou**, que o conteúdo já guarda. A data é o dia de São Paulo, ou "agora" para o que aconteceu há menos de uma hora. Os "Marcos da agência" mostram as mesmas datas e nomes.
5. **O passo 4** ("Seu cliente aprova pelo link, sem criar conta") tem "Enviar link de aprovação" e "Copiar link", que compartilham o endereço de entrada do portal, como em [`2026-11-10-compartilhar-o-acesso-ao-portal-por-link-e-whatsapp`](2026-11-10-compartilhar-o-acesso-ao-portal-por-link-e-whatsapp.md); não geram token nem enviam nada.
6. **O que sai.** Saem os atalhos de módulo e o bloco "Você pode adiantar". Entram o botão "Novo conteúdo" (abre o novo conteúdo do cliente, ou pede o cliente) e a data e o "Bom dia, <nome>".

**Substitui.**

- Em [`2026-11-10-jornada-ate-a-primeira-aprovacao`](2026-11-10-jornada-ate-a-primeira-aprovacao.md) e [`2026-11-06-caminho-de-ativacao-e-marcos-da-agencia`](2026-11-06-caminho-de-ativacao-e-marcos-da-agencia.md), a regra de que a leitura de ativação responde só quatro fatos: passa a responder também a data e o nome de cada passo. As demais regras (derivado dos dados, permissão do botão, some quando completa, marcos) continuam.
- O item 4 de [`2026-11-06-caminho-de-ativacao-e-marcos-da-agencia`](2026-11-06-caminho-de-ativacao-e-marcos-da-agencia.md) não muda; só ganha datas.

**Consequência.**

- Só leituras: não é estrutural e nenhuma tabela muda. A rota de ativação ganha data e nome; uma leitura nova (ou campo do resumo) traz "Aprovados no mês" e "Agendados", sob `conteudo.visualizar`. O nome da pessoa do portal só vem a quem tem `cliente.convidar_usuario`; sem essa permissão, o passo mostra o nome do cliente.
- O fluxo mobile da agência descreve o Início.

**Origem.** Pedido do dono do produto em 2026-11-11 e decisão do maestro sobre a métrica do mês (risco 18 do inventário).

**Validação.** Validada pelo dono em 2026-11-12.
