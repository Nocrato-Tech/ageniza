# Permissões de clientes: todos veem todos, e cadastrar é administrativo
**Data.** 2026-09-26

**Contexto.** O v1 diz que todo colaborador enxerga Clientes. A alternativa era restringir cada colaborador aos clientes atribuídos a ele — mas a tabela de atribuição não existe, e `clients_select` libera leitura a qualquer membro da agência.

**Decisão.** Todo colaborador vê **todos** os clientes da agência. O catálogo do módulo:

| capacidade | permissão |
|---|---|
| Ver listagem, detalhe e estudo de marca | `cliente.visualizar` |
| Editar cadastro e estudo de marca, responder e resolver thread | `cliente.operar` |
| Cadastrar cliente novo | `cliente.cadastrar` |
| Arquivar e reativar | `cliente.arquivar` |
| Convidar pessoa para o portal | `cliente.convidar_usuario` *(já existe)* |
| Reenviar e cancelar convite de portal | `convite.reenviar` · `convite.cancelar` *(já existem)* |
| Remover pessoa do portal e reativá-la | `cliente.remover_usuario` |

**Cadastrar é administrativo**, separado de `operar`: cliente novo é compromisso comercial, e a cobrança prevista é por número de clientes.

No portal, a pessoa do cliente abre e responde thread, mas **só a agência resolve** — resolvida significa "a agência tratou", e o cliente fechando a própria sugestão apagaria esse sinal.

**Consequência.** Restringir visibilidade por atribuição fica em aberto, com gatilho: **a primeira agência precisar esconder um cliente de parte da equipe**. Atribuir responsável nasce em Conteúdo e Tarefas; usar a atribuição para restringir leitura é decisão à parte, local à RLS de `clients`.

`convite.reenviar` e `convite.cancelar` valem para os dois tipos de convite, e `invitations_select` não separa por tipo: quem recebe `cliente.convidar_usuario` enxerga também os convites pendentes de colaborador. Enquanto só o Admin detiver as duas famílias, isso é invisível.

**Origem.** Decidido em sessão (entrevista do módulo de clientes).

