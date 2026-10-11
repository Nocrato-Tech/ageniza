# O e-mail ao cliente: um por grupo, link do portal sem token, texto mínimo e relógio de um minuto

**Data.** 2026-10-11

**Contexto.** A SPEC de Conteúdo (seção 8) pede os dois e-mails ao cliente, "conteúdos para aprovar" agrupado e "publicado" em resumo diário, enviados pelo worker a partir da fila de notificação, com "link para o portal" (issue #260). Ela não diz o texto, o destino exato do link, de quanto em quanto tempo o worker pergunta à fila nem o que o log pode conter. A fila (`2026-10-08-fila-de-notificacao-so-se-le-e-se-escreve-por-funcao.md`) decide **quando** um item pode sair; esta decisão fecha o que o worker faz com ele.

**Decisão.**
1. **Um e-mail por pessoa, cliente e tipo**, com todos os conteúdos do grupo que ainda valem. O assunto diz a quantidade ("3 conteúdos para você aprovar: <cliente>", "um conteúdo publicado: <cliente>"). Cada conteúdo aparece pelo **título** e pela **data planejada** (dd/mm/aaaa); legenda, mídia, responsável, subtarefa e prazo interno nunca entram (regra 1 da SPEC: o portal não vê trabalho interno, e o e-mail é o portal por outro meio).
2. **O link é `<APP_PUBLIC_URL>/portal/<cliente>/calendario`**, sem token, sem parâmetro e sem identificador da pessoa: abrir o portal exige a sessão dela, e um link que autenticasse seria uma credencial no e-mail. O destino é o calendário porque é onde a SPEC manda o cliente aprovar ou pedir ajuste; hoje a tela é um esqueleto, e quando a aprovação ganhar a tela própria o destino muda numa função só (`portalUrlFor`).
3. **O texto do e-mail é mínimo e neutro**, como o dos convites: quem enviou, quantos, a lista e uma frase de convite ao portal. O resumo de "publicado" não diz "hoje" nem "ontem": o e-mail que o worker atrasou, ou que leva dias atrasados juntos (`2026-10-08-resumo-diario-de-publicados-fecha-na-virada-do-dia-em-brasilia.md`), continua verdadeiro. O que vem do conteúdo (título, nomes do cliente e da agência) é **escapado** no HTML e nunca entra em cabeçalho com quebra de linha.
4. **Antes de enviar o worker reconfere** (`2026-10-11-a-fila-reconfere-o-item-logo-antes-do-envio.md`) e manda só o que voltar. Quando a reconferência devolve menos itens, o e-mail sai com os que sobraram; quando não devolve nenhum, nada sai.
5. **Falha do provedor não perde nem repete.** O item volta para a fila com um código (`smtp_temporary` para resposta 4xx, `smtp_rejected` para 5xx, `smtp_<código de rede>` como `smtp_etimedout`, ou `smtp_failed`), nunca o texto do provedor, que traz o endereço, e é tentado de novo com o atraso que a fila já define (5 minutos vezes as tentativas já feitas, no máximo 5 tentativas). Só se repete um e-mail se o worker morrer entre o envio e a marca de enviado; por isso a marca é tentada três vezes antes de o erro subir.
6. **O worker pergunta à fila a cada minuto**, e uma vez ao subir, no fuso de São Paulo. O relógio é só uma pergunta: o prazo de 15 minutos e a virada do dia continuam na fila, e o atraso máximo que o pergunta soma é um minuto. Uma execução reivindica até 10 grupos por vez e no máximo 6 vezes, e não começa uma reivindicação depois de 4 minutos, para o último grupo ser reconferido bem dentro do arrendamento de 10 minutos; a reconferência recusa o item de arrendamento vencido, então um grupo atrasado nunca é enviado.
7. **O log traz contagens e códigos**, nunca endereço, nome, título, token, identificador de item ou de pessoa, nem o link. O transporte de e-mail registra só o destinatário mascarado (domínio) e o modelo.
8. **Sem transporte, sem origem do web app ou sem fila, o job não se registra**, e o worker avisa no log. Em produção a configuração recusa subir sem `SMTP_URL`, `EMAIL_FROM` e `APP_PUBLIC_URL`, que o deploy já exige no arquivo de ambiente de produção: nenhuma variável nova entra na lista do deploy, e o contêiner local do worker passa a receber `APP_PUBLIC_URL`.

**Consequência.**
- Trocar o texto, o destino do link ou o relógio é mexer em um arquivo do worker ou do pacote de e-mail, sem migration.
- Um e-mail grande (muitos conteúdos numa rajada de até 60 minutos) lista todos; não há limite de itens por e-mail.
- Quando o cliente ganhar preferências de notificação (seção 10 da SPEC), elas entram antes da reconferência, no mesmo ponto.

**Origem.** Issue #260; `specs/conteudo.md`, seção 8 e regras 1 e 8; decisões da fila de 2026-10-08.

**Validação.** Pendente de validação do dono.
