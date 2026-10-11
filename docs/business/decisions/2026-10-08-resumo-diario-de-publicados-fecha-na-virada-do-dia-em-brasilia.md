# O resumo diário de "publicado" sai na virada do dia em Brasília

**Data.** 2026-10-08

**Contexto.** A SPEC (seção 8) pede o e-mail de "publicado" em **resumo diário**, e não diz a que horas o dia se fecha nem se cada publicação gera um aviso. A hora do envio é decisão do dono do produto.

**Decisão.** Cada publicação entra na fila no instante em que acontece, e o item só fica **pronto quando o dia em que foi publicado termina em `America/Sao_Paulo`** (meia-noite de Brasília). O e-mail do dia leva todas as publicações do dia daquela pessoa, sobre aquele cliente; se o worker ficou parado por mais de um dia, o e-mail seguinte leva os dias atrasados juntos. O dia é lido pela função única `app_private.sao_paulo_date`. Publicação desfeita no mesmo dia sai do resumo (ver a decisão sobre descartar o que deixou de valer).

**Consequência.**
- O resumo de ontem chega logo depois da meia-noite, o que pode ser cedo demais para quem lê; trocar por um horário fixo de manhã é mudar `app_private.notification_send_after`, sem mexer na tabela nem no worker.
- O prazo vive em `notification_send_after(tipo, instante)`, testado em instantes fixos às 22h30 e à meia-noite de Brasília.

**Origem.** Interpretação feita na implementação da #252, sobre a seção 8 de `specs/conteudo.md`.

**Validação.** Pendente de validação do dono.
