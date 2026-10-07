# ESTRUTURAL: convite de portal e arquivamento do mesmo cliente se serializam por trava de linha
**Data.** 2026-10-06

**Contexto.** A re-revisão de segurança do PR #202 (#123) executou, com duas transações reais, o cenário em que um convite de portal sobrevive ao arquivamento do cliente. T1 arquiva e mantém o commit pendente; T2 insere o convite, a policy `invitations_insert` ainda enxerga o cliente `active` (a visão de T2 não inclui a escrita não confirmada de T1) e o `INSERT` espera pela chave estrangeira. Quando T1 confirma, o `INSERT` conclui: o cliente fica `archived` com um convite pendente, contra as regras 6 e 15 da SPEC de clientes. A policy não resolve sozinha: ela avalia o estado de uma visão que o commit concorrente já tornou velha, e `archive_client` não enxerga uma linha que ainda não existe.

**Decisão.** Uma trigger `AFTER INSERT` por linha em `public.invitations`, para `purpose = 'client_invite'`, chama uma função `security definer` de escopo único que trava o cliente com `FOR SHARE` e relê `status` **depois** da espera. Se o cliente deixou de estar `active`, levanta `A0020` e a linha não existe. Duas escolhas fixam a forma:

- A trava vem **depois** da autorização. A `WITH CHECK` da policy roda antes dos gatilhos `AFTER`, então quem não tem a permissão (ou aponta para cliente de outra agência) é recusado pela policy sem nunca esperar por trava de outro tenant; a mesma regra que a #202 já aplicou às cinco funções. Uma trigger `BEFORE` travaria antes da policy, e por isso foi descartada.
- `FOR SHARE`, não `FOR KEY SHARE`: ela conflita com o `FOR UPDATE` de `archive_client` e `archive_due_clients` e também com qualquer escrita futura na linha do cliente, em vez de depender de qual função a toma. A trigger recebe nome que a ordena **antes** da trigger da chave estrangeira (`RI_ConstraintTrigger_*`, e as `AFTER` disparam em ordem de nome), para que a trava e a releitura sejam dela e não dependam da espera da chave estrangeira. A função é `security definer` porque a trava de linha exige passar também pelas policies de `UPDATE` de `clients`, que quem só convida não tem; invocada como `ageniza_app`, ela não travaria nada e recusaria convite legítimo.

A ordem inversa já estava correta e fica coberta por teste: se o convite é inserido primeiro, o `FOR UPDATE` do arquivamento espera por ele e o `UPDATE` seguinte (visão nova, em `READ COMMITTED`) o revoga.

**Consequência.** Nenhuma tabela é alterada: uma função e uma trigger novas, numa migration nova (`20261006000400_client_invitation_archive_serialization.mjs`), sem editar a que a #123 já introduziu. O arquivamento passa a convidar a corrida só por um caminho já arbitrado pelo banco, e toda escrita futura que "pendura" uma linha num cliente (conteúdo agendado, por exemplo) deve copiar este formato: a policy decide quem pode, a trava com releitura decide se ainda pode.

**Alcance que não foi tocado.** As outras tabelas filhas do cliente citadas na regra 6 (seções, personas, threads, comentários) têm a mesma forma de risco (provado por execução para `client_personas`: uma persona inserida enquanto o arquivamento ainda não confirmou sobrevive, com o cliente `archived`; seções, threads e comentários não foram sondados) e **não** são alteradas aqui: pertencem a outras tasks do módulo, e mexer nelas dentro deste PR seria mudança em tabela de outro módulo. Fica registrado como débito para o maestro abrir.

**Origem.** Re-revisão do PR #202, achado Alta de 2026-10-01. Issue #123.

