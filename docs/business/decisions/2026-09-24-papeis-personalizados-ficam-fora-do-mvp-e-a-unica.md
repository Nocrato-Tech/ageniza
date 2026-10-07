# Papéis personalizados ficam fora do MVP, e a única capacidade não delegável hoje é a posse

**Data.** 2026-09-24

**Contexto.** O schema já suporta papel por agência — `roles.agency_id` com `is_system`, aceito tanto pela RLS quanto pelo guard da API. O que falta é tela de criar, duplicar e atribuir, e a regra do que nunca pode entrar num papel personalizado. Mas o catálogo tem quatro permissões: não há combinação a montar.

**Decisão.** Papéis personalizados ficam **fora do MVP**. O gatilho que reabre o assunto é **uma agência precisar de uma combinação que os cinco presets não expressam** — não uma data. Quando existirem, a capacidade **não delegável** é a **transferência de posse**.

**Consequência.** Adiar custa quase nada porque o modelo já está pronto; o que se evita é construir tela para combinar quatro permissões. Assinatura e faturamento **não** entram na lista de não delegáveis por enquanto porque ainda não existem no produto — quando existirem, entram por definição, junto com a decisão que os criar.

**Origem.** Decidido em sessão (sessão 0 de autorização e transversais).

