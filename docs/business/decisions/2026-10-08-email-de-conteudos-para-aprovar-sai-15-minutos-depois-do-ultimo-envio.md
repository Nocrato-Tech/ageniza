# O e-mail de "conteúdos para aprovar" sai 15 minutos depois do último envio para aprovação

**Data.** 2026-10-08

**Contexto.** A SPEC (seção 8) diz: "conteúdos para aprovar" agrupado **com espera de 15 minutos após o último envio**. "Envio" admite duas leituras: o último **e-mail** enviado à pessoa (o primeiro e-mail sairia na hora e os seguintes seriam espaçados), ou o último **conteúdo enviado para aprovação** pela agência (o verbo da SPEC, "enviar para aprovação"). A implementação da #252 começou pela primeira; o dono do produto corrigiu: a agência costuma enviar vários posts seguidos, e o cliente deve receber **um** e-mail com todos.

**Decisão.** É um **debounce**. O e-mail de "conteúdos para aprovar" de uma pessoa, sobre um cliente, sai 15 minutos depois do **último conteúdo enviado para aprovação** daquele cliente, e leva junto tudo o que se acumulou na rajada. Cada envio novo dentro da janela adia a saída do grupo; **nada sai na hora**. Três envios com 5 minutos de intervalo geram um e-mail só, 15 minutos depois do terceiro.

O adiamento tem **teto de 60 minutos contados do envio mais antigo ainda em aberto do grupo** (a sugestão do dono, aceita como padrão): uma agência que envia um post a cada 14 minutos não deixa o cliente sem e-mail para sempre. Passado o teto, sai o que já venceu a janela de 15 minutos; o que acabou de chegar abre a janela seguinte.

Enviar de novo o mesmo conteúdo antes de o e-mail sair (tirá-lo da aprovação e reenviá-lo) é a mesma linha do e-mail, e **também adia** a saída: a janela de 15 minutos recomeça, e o momento em que o item foi aberto pela primeira vez continua valendo para o teto. Um item que já está saindo num e-mail (reivindicado por um worker) não é mexido.

O debounce vale por pessoa, por cliente e por tipo. O resumo de "publicado" não é debounced: sai na virada do dia (decisão de 2026-10-08 sobre o resumo diário). Dois e-mails do mesmo grupo nunca ficam em voo ao mesmo tempo.

**Consequência.**
- Editar a legenda ou a data de um conteúdo que **já está** em "aguardando aprovação" não enfileira nada: só a **passagem** para esse estado conta, e isso vale também depois de o e-mail ter saído.
- O prazo (15 minutos) vive em `app_private.notification_send_after(tipo, instante)`, e o teto (60 minutos) em `app_private.notification_max_wait(tipo)`; mudar um dos dois é trocar uma função, sem mexer na tabela nem no worker.
- Um cliente que recebe os envios de uma agência lenta pode ficar até 75 minutos sem e-mail do primeiro post da rajada (60 minutos de teto mais a janela do último). É o preço do agrupamento, e o teto é o botão.
- Um post enviado e aprovado dentro da janela não gera e-mail: o item é descartado antes de sair (decisão sobre descartar o que deixou de valer).

**Origem.** Seção 8 de `specs/conteudo.md`; leitura definida pelo dono do produto na implementação da #252, em 2026-10-08. O teto de 60 minutos foi a sugestão dele, aplicada como padrão.

**Validação.** Pendente de validação do dono.
