# Remover e reativar: quem vê removidos, o estado errado é 409, e a sessão não é encerrada
**Data.** 2026-10-07

**Contexto.** A #98 implementa `POST …/remove` e `POST …/reactivate`. A SPEC fixa as permissões, as proteções e que a reativação exige o papel no corpo; não fixa qual permissão é "administrativa" para revelar vínculos removidos (regra inviolável 9, e "apenas para Admin e Owner" em 2026-09-24), nem o que acontece ao remover quem já está removido (a issue deixa a escolha), nem o que a remoção faz com a sessão da pessoa. Nada abaixo muda tabela, policy ou formato de resposta usado por outra rota.

**Decisão.**

1. **Quem vê vínculos `removed` é quem tem `colaborador.remover` ou `colaborador.alterar_papel`, além do Owner por posse.** O critério é a tarefa, não o nome do papel: quem pode remover ou reativar precisa encontrar a pessoa para fazê-lo, e uma agência pode montar um papel personalizado de administração do quadro sem usar o preset `admin`. `?status=removed` sem nenhuma das duas é `403` (depois da guarda e da validação, antes de qualquer leitura) e o detalhe de um removido é `404`; a listagem padrão e `status=active` nunca mostram removidos. É um desvio deliberado de "apenas para Admin e Owner" (2026-09-24), que assumia os presets: o `account_manager`, que edita cargo mas não papel, não vê removidos.
2. **O estado errado é `409`, nos dois sentidos.** Remover quem já está removido (`COLLABORATOR_ALREADY_REMOVED`) e reativar quem não está removido (`COLLABORATOR_NOT_REMOVED`) são rejeitados, e nada muda, nem `updated_at`. A alternativa descartada foi a remoção idempotente (`200` sem escrita): ela responde sucesso sem uma linha alterada, o mesmo defeito que a #97 recusa, e reativar com um papel no corpo não tem como ser idempotente.
3. **Remover não encerra sessão.** A sessão é global (Better Auth) e não existe sessão por agência; o acesso à agência é decidido a cada requisição por `requireAgencyAccess`, que só enxerga vínculo `active`. A pessoa perde a agência na requisição seguinte, com o mesmo cookie, e continua com as outras agências. Confirmado por teste; a SPEC não pede mais que isso.
4. **Reativar com o papel `admin` exige `colaborador.atribuir_admin` na rota**, como a troca de papel e o convite (decisão de 2026-10-07 sobre o `PATCH`). A mesma checagem vale para quem foi Admin e volta como Admin.

**Consequência.** A remoção continua sem regra de "último Admin" (2026-09-24). A segunda barreira do banco tinha uma lacuna exatamente no caminho de reativação que esta task cria; ela é fechada neste mesmo PR, pela decisão estrutural seguinte.

**Origem.** Issue #98. As decisões 1 e 2 estão **pendentes de validação** pelo dono do produto; a 1 foi proposta antes, para a #98, em branch antiga que não chegou a PR. A 3 foi confirmada pelo maestro (a sessão é global e o acesso cai na requisição seguinte).

