# "Atrasado" conta pela data de publicação que passou, e "Parado no cliente" segue a ordem de envio

**Data.** 2026-11-11

**Contexto.** O Início da agência tem hoje o bloco "Atrasados", que conta o **prazo de aprovação** vencido, e a lista "Parado no cliente", ordenada por urgência do prazo. O quadro do redesenho (r0) mostra "Atrasados: 1, a data passou sem aprovação, Cobrar o cliente" e a lista "Do mais antigo para o mais novo", com a linha "deveria ter saído em 9 de novembro". As duas coisas estavam separadas de propósito na decisão [`2026-11-10-parado-no-cliente-no-inicio-da-agencia`](2026-11-10-parado-no-cliente-no-inicio-da-agencia.md), para não confundir os dois prazos.

**Decisão.**

1. **Atrasado é um só.** "Atrasado" é a **data de publicação** que passou (dia de São Paulo anterior a hoje) sem o conteúdo estar publicado nem cancelado, em qualquer estado aberto. É a regra de [`2026-10-11-conteudo-calendario-da-agencia-semana-na-segunda-e-prazo-em-dois-dias`](2026-10-11-conteudo-calendario-da-agencia-semana-na-segunda-e-prazo-em-dois-dias.md) (item 3), agora também no bloco "Atrasados" do Início. O prazo de aprovação vencido não é "Atrasado": é "venceu há N dias" e gera a notificação "venceu o prazo".
2. **O bloco "Atrasados"** conta os conteúdos atrasados que estão **aguardando o cliente** ("a data passou sem aprovação"). A ação é "Cobrar o cliente", que só compartilha o endereço do portal (ver [`2026-11-11-estrutural-notificacoes-so-dentro-do-app-com-cinco-eventos`](2026-11-11-estrutural-notificacoes-so-dentro-do-app-com-cinco-eventos.md), item 6).
3. **Ordem de "Parado no cliente".** Do conteúdo **enviado há mais tempo** para o mais novo (`sentAt`); o sem data de envio (anterior às rodadas) vai por último, pela data de publicação. Os clientes seguem a ordem do primeiro conteúdo de cada um. O corte de 50 tira o mais novo.
4. **Linha do conteúdo.** Mostra a capa, o formato, e "deveria ter saído em <data>" quando a data de publicação passou, ou "enviado há N dias". As etiquetas são "Atrasado N dias" e "Aguardando aprovação". O estado do prazo de aprovação continua na linha, como segunda informação, e não ordena a lista.
5. **Cabeçalho do grupo.** O cliente, quantos posts e **quem aprova** (o nome da pessoa ativa do portal; com mais de uma, o primeiro e "e mais N"), e a ação secundária "Reenviar o link", que só compartilha.

**Substitui.**

- Os itens 2 e 4 de [`2026-11-10-parado-no-cliente-no-inicio-da-agencia`](2026-11-10-parado-no-cliente-no-inicio-da-agencia.md): o item 4 ("o vocabulário é diferente do prazo de publicação") deixa de valer para o bloco "Atrasados" e a ordem; o estado do prazo de aprovação continua com o vocabulário do item 2.
- A ordem "mais urgentes primeiro" que o fluxo `docs/mobile/fluxos/agencia.md` descrevia para `awaiting-client`.

**Consequência.**

- Não é estrutural: nenhuma tabela muda. O `awaiting-client` passa a devolver a capa (`thumbnailAssetId`), quem aprova e o dado de atraso; a ordem muda no servidor. A lista nova é de leitura, sob `conteudo.visualizar`, e nenhuma outra rota copia o formato dela.
- A leitura do nome de quem aprova só traz o que a agência já vê na aba Acessos do cliente, e só para quem tem `cliente.convidar_usuario`; sem essa permissão o cabeçalho do grupo mostra só o cliente.

**Origem.** Pedido do dono do produto em 2026-11-11 e decisão do maestro de que o atraso é pela data de publicação e a ordem é a de envio.

**Validação.** Pendente de validação do dono.
