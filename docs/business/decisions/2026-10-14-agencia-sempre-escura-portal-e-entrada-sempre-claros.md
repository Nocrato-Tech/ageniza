# Área da agência sempre escura; portal, entrada e páginas públicas sempre claros

**Data.** 2026-10-14

**Contexto.** O épico #621 (Pauta) fixa o tema escuro como padrão da área da agência. Os tokens do escuro existem desde #622 e nada no app os ligava. Faltava decidir quem escolhe o tema: a pessoa, o sistema operacional ou a área.

**Decisão.**
1. Toda rota `/agencia/...` (inclusive carregando, não encontrada e id inválido) roda com `data-theme="dark"` em `<html>`; o atributo sai quando a pessoa deixa a área e volta o valor que havia.
2. Portal do cliente, login, convite, esqueci a senha, termos, privacidade, status e seletor de contexto continuam claros. O portal fica de fora até o dono decidir sobre ele (épico #621).
3. Não há seletor de tema nem leitura de `prefers-color-scheme`: a área decide.

**Consequência.** Os pares do escuro passam a valer nas telas atuais. A auditoria feita nesta tarefa (PR da #623) lista o que ficou ruim e é refeito nas próximas tasks do épico: borda `border/default` abaixo de 3:1, e `text/danger` e `text/link` sobre `bg/elevated`/`bg/hover` abaixo de 4,5:1. Ligar um seletor depois muda esta decisão e pede outra.

**Origem.** Issue #623, épico #621.

**Validação.** Pendente de validação do dono.
