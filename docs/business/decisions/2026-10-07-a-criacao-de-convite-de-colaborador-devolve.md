# A criação de convite de colaborador devolve `supersededInvitationId`

**Data.** 2026-10-07

**Contexto.** A tela avisava "o convite anterior deixou de valer" por uma heurística sobre o cache das páginas de convites já carregadas (24 por página), apontada na revisão do #327: com mais de uma página, ou cache velho, a criação revogava o convite anterior em silêncio (issue #333, item que ficou de fora do #322). A rota de criação já revoga o pendente equivalente dentro da mesma transação; o dado existia só no banco.

**Decisão.** `POST /agencies/:agencyId/invitations/collaborators` passa a responder `supersededInvitationId: <uuid|null>` — o id do convite ainda válido que a própria criação revogou, `null` quando não havia nenhum (um vencido é revogado, mas já não era link). A resposta ganha um schema próprio (`CollaboratorInvitationCreatedResponseSchema`, `.strict()`, estendendo o contrato compartilhado de criação/reenvio); as outras duas rotas que usam `InvitationCreatedResponseSchema` (criação de convite de cliente e reenvio) ficam intactas, e o reenvio não precisa do campo: quem chamou já conhece o convite substituído. A tela usa o campo da resposta e a heurística sai.

**Consequência.** Mudança de API aditiva e local a uma rota, sem migration, sem RLS e sem backfill: nada existente muda de forma, e o id devolvido é sempre de um convite da mesma agência (a consulta já filtra por `agency_id`). Reabre quem voltar a usar o cache para saber o que a criação revogou — a resposta é a única fonte. Avaliação estrutural: não altera tabela, policy, autorização nem o formato que outras rotas já usam; o contrato compartilhado permanece o mesmo.

**Origem.** Issue #333 (item da #322, ressalva da revisão do PR #327), decidida pelo maestro. Validada pelo dono em 2026-10-08.

