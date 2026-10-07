# Acessos ao portal: remover e reativar pessoa são idempotentes, e cliente arquivado só se lê

**Data.** 2026-10-07

**Contexto.** A #132 entrega a lista de pessoas e a de convites pendentes do portal de um cliente, e remover e reativar pessoa, chamando `app_private.set_client_membership_status` (#123). A issue fixa as permissões, o filtro por `purpose` e `client_id`, o 409 para cliente arquivado ao convidar e ao remover, e o 404 para vínculo de outro cliente. Não fixa o que acontece ao remover quem já está removido (e o inverso), nem se a lista de pessoas de um cliente arquivado continua legível, nem qual permissão revela as pessoas `removed`. A função do banco é idempotente por desenho ("sem transição, sem escrita, sem evento"), ao contrário de remover colaborador, que a decisão `2026-10-07-remover-e-reativar-quem-ve-removidos-o-estado-errado-e-409` fez recusar o estado errado.

**Decisão.**

1. **Remover quem já está removido, e reativar quem já está ativo, respondem `200` com o vínculo como está**, sem escrever, sem evento de auditoria e sem alterar `updated_at`. Seguimos a função da #123 em vez do 409 dos colaboradores: lá a reativação carrega um papel no corpo e não tem como ser idempotente; aqui não há corpo, e repetir o clique de um Admin não é um erro. O estado vem da leitura do vínculo depois da chamada, nunca do corpo.
2. **Cliente arquivado é somente leitura**: a lista de pessoas e a de convites respondem `200`, e remover ou reativar pessoa responde `409 CLIENT_ARCHIVED`, inclusive reativar quem já estava removido. Cliente de outra agência, inexistente ou com id malformado é o mesmo `404`; a existência de um cliente da própria agência não é segredo para quem a administra.
3. **As pessoas `removed` aparecem para quem tem `cliente.convidar_usuario`**, a permissão da rota na SPEC. Não pedimos `cliente.remover_usuario` a mais para `status=removed`, como os colaboradores pedem: a SPEC dá uma permissão só à rota, e hoje as duas pertencem ao mesmo preset (Admin). Se um papel personalizado vier a separar as duas, a decisão volta.
4. **Convidar para cliente arquivado responde `409 CLIENT_ARCHIVED`**, e não o `404` que respondia: o cliente existe na agência, então dizer que está arquivado não revela nada, e o convite nasceria morto. Cliente arquivado de outra agência continua `404`.
5. **A lista de convites do cliente filtra por `client_id` e por `purpose = 'client_invite'`**, e um teste prova que convite de colaborador, de ativação e de outro cliente não aparecem para quem a policy deixa ler. Reenviar e cancelar continuam sendo as rotas de convite que já existem, com `convite.reenviar` e `convite.cancelar` válidas para os dois tipos: só o Admin gerencia acessos até a #148.

**Consequência.** Nenhuma tabela, policy ou função nova: as rotas usam o que a #123 entregou. A decisão 3 é a única que pode reabrir se `cliente.convidar_usuario` e `cliente.remover_usuario` passarem a ser concedidas separadamente.

**Origem.** Issue #132; `specs/clientes.md`, seções 2, 4, 5 e 6; `docs/business/structural-changes.md`, "Permissões de convite compartilhadas entre tipos".

**Validação.** Pendente de validação do dono.
