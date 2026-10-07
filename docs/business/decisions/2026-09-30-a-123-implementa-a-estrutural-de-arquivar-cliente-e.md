# A #123 implementa a estrutural de arquivar cliente e substitui `invitations_insert`

**Data.** 2026-09-30

**Contexto.** A decisão de 2026-09-26 ("ESTRUTURAL: arquivar cliente é uma função `security definer` de escopo único, usada pelo job e pela rota") deixou a implementação para a issue #123, e a de 2026-09-18 ("O processamento de vídeo não contorna o RLS") é a regra a que aquela abre exceção. A #123 também tem de substituir a policy `invitations_insert` que o PR #159 deixou, porque ela aceita convite de portal para cliente arquivado, contra a regra 6 da SPEC.

**Decisão.** Nenhuma decisão nova: esta entrada registra a implementação da estrutural já decidida, na forma estreita que ela fixou — cada função faz uma coisa só, confere a agência e a permissão **dentro** da função quando há usuário (o job não tem usuário e só arquiva o que já venceu), com `search_path` fixo e todo objeto qualificado por schema. As cinco funções são `app_private.archive_client`, `archive_due_clients`, `reactivate_client`, `set_client_closing_date` e `set_client_membership_status`, e os erros estáveis (A0020..A0023) ficam documentados na migration para a API #131 traduzir.

**Consequência.** `invitations_insert` passa a exigir `app_private.client_is_active(client_id)` para `purpose = 'client_invite'`, mantendo a regra de admin do convite de colaborador do #159. `clients.status`, `clients.archived_at`, `clients.closing_date` e `client_memberships.status` continuam fora do *grant* de `UPDATE` de `ageniza_app`: a única forma de mudá-los é por estas funções. Isso cumpre a regra 12 e a 13 da SPEC e é o modelo que a publicação agendada de Conteúdo deve copiar.

**Origem.** Issue #123; migration `20261006000300_client_lifecycle_functions.mjs`.

