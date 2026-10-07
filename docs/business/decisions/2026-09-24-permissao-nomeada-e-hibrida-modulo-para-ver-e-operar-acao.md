# Permissão nomeada é híbrida: módulo para ver e operar, ação para o administrativo

**Data.** 2026-09-24

**Contexto.** O catálogo de permissões já existe desde a migration `20260919000000_tenancy_and_invitations.mjs`, com `permissions`, `roles`, `role_permissions` e `app_private.has_agency_permission` resolvendo por permissão nomeada — não era decisão nova, era decisão de conteúdo. O Notion propunha uma permissão por módulo **e** uma por ação, o que chegaria a cerca de quarenta linhas quando todos os módulos existissem, a maioria sem ninguém que as diferenciasse.

**Decisão.** O catálogo é híbrido: `<modulo>.visualizar` e `<modulo>.operar` cobrem o uso normal do módulo, e permissão nomeada de ação existe **apenas** para o que é administrativo ou destrutivo. As quatro permissões já existentes — `colaborador.convidar`, `cliente.convidar_usuario`, `convite.reenviar`, `convite.cancelar` — já seguem esse formato e permanecem como estão.

**Consequência.** Um nível de módulo por si só não expressa "vê e opera cliente mas não convida usuário do cliente", e é exatamente por isso que a metade administrativa continua sendo por ação. Cada entrevista de módulo passa a produzir duas coisas no catálogo: o par de módulo e a lista de ações administrativas dele. Permissão nova é `insert` em `permissions` e `role_permissions` — migration aditiva, sem alcance estrutural.

**Origem.** Decidido em sessão (sessão 0 de autorização e transversais).

