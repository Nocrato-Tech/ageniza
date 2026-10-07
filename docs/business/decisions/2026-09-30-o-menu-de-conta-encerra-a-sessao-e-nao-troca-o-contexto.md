# O menu de conta encerra a sessão e não troca o contexto

**Data.** 2026-09-30

**Contexto.** A issue #70 leva para a interface as ações de sessão que já existem na API e exige o menu em toda tela autenticada. A troca de contexto tem fluxo próprio na issue #78 e não deve ser antecipada pelo menu desta issue.

**Decisão.** O cabeçalho autenticado mostra o nome e o e-mail da pessoa dentro do menu de conta. Quando houver contexto ativo, ele aparece no menu e permanece visível no cabeçalho fechado. `POST /auth/logout` encerra a sessão atual; `POST /auth/logout-all` encerra todas as sessões e exige confirmação explícita. Depois de qualquer sucesso, a interface limpa o cache client-side da conta anterior e leva a pessoa para `/entrar`. Um `401` no logout significa que a sessão já não existe: a saída é tratada como concluída e não guarda o destino da conta anterior, para que a próxima conta na mesma aba não seja levada ao endereço de quem saiu. A troca de contexto continua fora do escopo da #70 e fica para a #78.

**Consequência.** O menu não oferece seletor nem inventa uma regra para escolher contexto. A ação de encerrar todas as sessões fica separada e com tratamento visual destrutivo, para distinguir o alcance da ação antes da confirmação.

**Origem.** Decidido pelo dono do produto na especificação da issue #70 e confirmado durante sua implementação.

