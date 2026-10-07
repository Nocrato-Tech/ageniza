# Portal: lê o cadastro inteiro do próprio cliente, e o Início conta só o que o portal enxerga

**Data.** 2026-10-07

**Contexto.** A #129 entrega `GET /clients/:clientId` e `GET /clients/:clientId/brand-study` para a pessoa do portal. A issue manda devolver "o cadastro inteiro do cliente, somente leitura", o nome da agência, `onboardingSeenAt` do vínculo de quem chama e o resumo do Início (`threadsAnsweredByAgency`, `brandStudyFilled`, "mesma definição de #124"), e o estudo "na mesma forma de #127" sem persona arquivada e sem `updatedBy`. Não diz o que o Início faz com a thread de persona arquivada, que o portal não lê desde a #130, nem o que fica do `updatedBy` em `updatedAt`. A RLS decide **quem** lê uma linha, não **por qual lado**: o colaborador que também tem vínculo de cliente lê, pelo ramo de membro da agência de cada policy, a persona arquivada e as threads de todos os clientes da agência.

**Decisão.**

1. O cadastro vai inteiro, os mesmos campos do detalhe da agência, mais `agencyName`, `onboardingSeenAt` e `home`. `status` e `archivedAt` ficam fixados em `active` e `null` no contrato: o portal nunca alcança cliente arquivado, e uma linha que alcançasse falharia ao validar em vez de ser servida.
2. `home.threadsAnsweredByAgency` conta as threads **abertas** cujo último comentário é `agency`, **deste cliente**, e só as que o portal enxerga: a thread de persona arquivada fica de fora. É a mesma regra de leitura da #130, aplicada à contagem, e a contagem do portal pode ser menor que a do resumo da agência para o mesmo cliente. `home.brandStudyFilled` usa a definição única de `service.ts` (`personas` conta com ao menos uma persona ativa).
3. O estudo do portal tem as sete seções sempre, só as personas `active`, e **nem `updatedBy` nem o nome de quem editou**: quem editou por dentro é informação da agência. `updatedAt` fica. As consultas do portal não selecionam `updated_by`, então o campo não chega à resposta por engano de mapeamento.
4. Toda regra que só vale para o portal (persona ativa, cliente da guarda, vínculo próprio) é **filtro explícito do SQL do lado cliente**, nunca consequência da policy. Cada rota de portal tem teste com a pessoa dupla (colaborador com vínculo de cliente), com a de papel sem nenhuma chave `cliente.*` e com a que é de uma agência e tem vínculo com cliente de outra.

**Consequência.** O Início da agência e o do portal podem mostrar números diferentes para a mesma thread, de propósito: o que o portal não lê não é pendência de quem lê pelo portal. Quando Conteúdo acrescentar assunto à thread, a regra de leitura do portal continua sendo o filtro explícito da consulta.

**Origem.** Issue #129; `specs/clientes.md`, seções 2, 6 e 7; decisão `2026-10-07-conversa-persona-arquivada-recusa-abrir-thread`.

**Validação.** Pendente de validação do dono.
