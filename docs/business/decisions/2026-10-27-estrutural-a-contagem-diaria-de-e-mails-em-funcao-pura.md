# Estrutural: a contagem diária de e-mails vira uma função pura do instante

**Data.** 2026-10-27

**Contexto.** O limite diário de e-mails de uma agência (A0095) lê a contagem em `app_private.agency_emails_today(p_agency_id)`, que pergunta o relógio dentro do próprio corpo. Nenhum teste conseguia colocar "agora" às 00:30 ou às 23:30 de São Paulo, e por isso nenhum prendia a janela: trocar o intervalo por `1 hour` deixava as suítes verdes (issue #727, achado Baixo da re-revisão do PR #725). A primeira tentativa (PR #730) usava o relógio do banco e ficava cega entre 00:00 e 01:30 em São Paulo. A migration que cria a função nova contém um `revoke`, e o gate de migrations reconhece isso como mudança estrutural (`verify-structural-decisions`).

**Decisão.**

1. A contagem vira uma função pura do instante: `app_private.agency_emails_sent_on_day(p_agency_id, p_at)` conta os e-mails enviados no dia de São Paulo que contém `p_at`, com as mesmas fontes (convites de colaborador e de cliente, e os eventos `client_member.added` e `client_member.readded`) e o mesmo recorte por `app_private.sao_paulo_date` de antes.
2. `agency_emails_today` passa a chamar a função nova com `now()`. O comportamento é igual: o limite continua por dia de São Paulo, o gatilho e `charge_daily_email` continuam chamando `agency_emails_today`, e nada muda para a API nem para a tela.
3. O `revoke` segue o padrão da função original: `revoke all ... from public`, `security definer`, `set search_path = ''`. O `ageniza_app` não chama a função nova diretamente, como não chama a original.

**Consequência.** Não altera tabela, policy, grant de tabela nem formato de resposta, e não exige backfill. O teste passa a chamar a função com instantes fixos (00:30 e 23:30 no mesmo dia, 23:59 da véspera fora, virada às 00:00 de São Paulo e não de UTC). Quem quiser contar o dia de outro instante usa a função nova, não copia a consulta. Mudar a janela ou a fonte da contagem passa a ser uma só edição, na função pura.

**Origem.** Issue #727, PR #738 (que substitui o #730); achado da re-revisão de segurança do PR #725.

**Validação.** Pendente de validação do dono.
