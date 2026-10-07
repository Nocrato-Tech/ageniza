# Owner é propriedade da agência, não papel

**Data.** 2026-09-15

**Contexto.** Seria natural modelar "owner" como mais um papel ao lado de Admin.

**Decisão.** Owner é uma coluna da agência (`owner_user_id`). Ele tem todas as permissões daquela agência por ser dono, e recebe também um vínculo com papel Admin.

**Consequência.** Nenhuma consulta deve procurar um papel chamado owner. Toda checagem de permissão precisa considerar o caminho do dono além do caminho do vínculo. Transferência de propriedade não existe ainda e será uma decisão à parte.

**Origem.** Issue #32, `AGENTS.md`.

