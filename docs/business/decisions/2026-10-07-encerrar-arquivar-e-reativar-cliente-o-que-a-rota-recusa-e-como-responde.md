# Encerrar, arquivar e reativar cliente: o que a rota recusa e como responde

**Data.** 2026-10-07

**Contexto.** A SPEC (`specs/clientes.md` seções 4 e 6) e a issue #131 descrevem as quatro rotas e os efeitos, mas não dizem o que cada uma responde em todo estado: reativar um cliente que já está ativo, desmarcar um encerramento que não existe, a disputa com a mudança de um convite do mesmo cliente. As funções da #123 já são idempotentes (arquivar arquivado e reativar ativo não escrevem nada), então a rota podia ou repetir o sucesso ou recusar.

**Decisão.**

1. Cliente arquivado: agendar, desmarcar e arquivar respondem `409 CLIENT_ARCHIVED`, porque a única ação de um cliente arquivado é reativar. A mensagem é "Cliente arquivado: a única ação possível é reativar."
2. Desmarcar sem encerramento agendado responde `409 CLOSING_DATE_NOT_SET` (está na issue). Reativar um cliente que já está ativo responde `409 CLIENT_NOT_ARCHIVED`, por simetria; a SPEC não cobre, e a interpretação mais conservadora é recusar uma transição que não existe em vez de fingir que ela aconteceu.
3. Reativar com o nome em uso entre os ativos responde `409 CLIENT_NAME_IN_USE` com "Já existe um cliente ativo com este nome. Renomeie um dos dois antes de reativar.", e o cliente segue arquivado. É o mesmo código do cadastro, com a mensagem de quem reativa.
4. Data de encerramento que não é um dia real do calendário ou é anterior a hoje em Brasília: `400 VALIDATION_ERROR`, com o campo `closingDate` em `details`. Ser hoje ou depois é a regra da função do banco, não da rota.
5. Arquivar concorrente com reenviar ou criar convite do mesmo cliente pode dar deadlock (`40P01`), porque o reenvio trava o convite e depois o cliente, e o arquivamento trava o cliente e depois os convites. A rota que perde responde `409 TRY_AGAIN`, sem detalhe do banco e sem nada gravado, como as rotas de convite já respondem desde a #335. Foi descartado mudar a ordem dos *locks* do reenvio e da criação para travar o cliente primeiro: seria mexer no módulo de convites e no caminho de aceite por uma disputa rara que repetir a chamada resolve.
6. As quatro rotas leem o estado antes de chamar a função, para dar a resposta certa sem exceção, e a função confere a permissão de novo na agência do cliente. Se ela recusar depois das checagens, a recusa é relida numa transação nova e vira o `403`, o `404` ou o `409` que a checagem teria dado, nunca `500`.
7. Criar ou reenviar o convite de portal de um cliente que é arquivado no meio da requisição também não é erro de servidor: o gatilho que trava o cliente (20261006000400) levanta `A0020`, e as duas rotas de convite o traduzem para o mesmo `409 CLIENT_ARCHIVED` que a leitura do cliente arquivado já dava, sem criar convite nenhum (achado da revisão de segurança do #386).

**Consequência.** Só código da API e o OpenAPI: nenhuma tabela, policy, permissão ou formato de resposta muda, e a rota devolve o mesmo cliente do `PATCH`. A tela de ações no detalhe (#139) traduz estes códigos. Dois `DELETE` simultâneos do mesmo encerramento podem passar pela checagem e gravar um segundo evento `client.closing_cleared` sem efeito; a função não duplica a mudança de estado, e travar a linha na rota exigiria `cliente.operar`, que quem só arquiva pode não ter.

**Origem.** Issue #131, a SPEC de clientes e a nota de 06/10 sobre o deadlock entre reenvio de convite e arquivamento; decisão do maestro com a autonomia dada pelo dono do produto em 2026-10-07.

**Validação.** Pendente de validação do dono.
