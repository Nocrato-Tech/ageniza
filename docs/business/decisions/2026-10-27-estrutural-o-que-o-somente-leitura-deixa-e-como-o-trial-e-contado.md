# ESTRUTURAL: o que o somente leitura do trial deixa fazer e como o banco conta o trial

**Data.** 2026-10-27

**Contexto.** A decisão de 2026-10-26 ([a agência nasce pelo produto, em trial de 14 dias](2026-10-26-estrutural-a-agencia-nasce-pelo-produto-em-trial-de-14-dias.md)) põe os limites e o somente leitura no banco. Ao implementar (#708, #709, #714), cada regra precisou de uma leitura exata, e a revisão do #720 ajustou três pontos antes do código.

**Decisão.**

1. **O somente leitura não bloqueia o que reduz acesso** (revisão do #720): remover colaborador, remover acesso ao portal e cancelar convite continuam valendo com o trial vencido, além do comando interno que troca o plano. O banco reconhece cada um pela mudança exata da linha (o vínculo de `active` para `removed`, o convite ganhando `revoked_at`), e nada mais pode mudar junto. Reativar colaborador ou acesso, convidar e reenviar convite são escritas como as outras e são recusadas.
2. **As contagens aguentam criações em paralelo** (revisão do #720): a contagem de clientes e a de colaboradores esperam uma trava por agência antes de contar, e "uma agência em trial" vale como o item 7 da decisão de 2026-10-26 manda, pelo **e-mail normalizado** do Owner (minúsculas, sem `+alias` e, no `gmail.com` e no `googlemail.com`, sem pontos e com o domínio unificado), além da própria conta. O banco calcula esse e-mail ao criar a agência, a partir do e-mail verificado da conta, espera uma trava por ele e pela conta antes de conferir, e dois índices únicos parciais (só nas agências em `trial`), um no e-mail normalizado e outro no Owner, são a última barreira.
3. **Com o trial vencido, o worker não envia e-mail da agência** (revisão do #720): a fila descarta os itens, como na suspensão. A retenção e o purge de mídia e o arquivamento agendado de clientes continuam, porque são manutenção: o somente leitura vale para a escrita de uma pessoa (com ator na transação), não para a do worker.
4. **Convite pendente** é o que não foi usado, não foi revogado e não venceu. Um convite vencido não ocupa vaga.
5. O **Owner conta uma vaga** mesmo que seja dono só por posse, sem vínculo. Reativar um colaborador removido ocupa vaga e é recusado com o trial cheio; aceitar um convite pendente não, porque a vaga dele já estava contada.
6. **Um trial vencido continua contando** para "uma agência em trial": só a troca do plano dessa agência para `ativo` ou `isenta` libera um trial novo.
7. As agências que já existiam ficam `isenta`. Nenhum comando cria agência (decisão de 2026-10-27, [a agência só nasce pelo produto e o plano isenta](2026-10-27-estrutural-a-agencia-so-nasce-pelo-produto-e-o-plano-isenta.md)). A troca para `trial` pelo comando interno com só a data termina às 23:59:59 de Brasília desse dia.
8. O trial termina no **instante** da criação mais 14 dias, e os 2 GB são 2 GiB (2 147 483 648 bytes) na `agency_storage_quotas`. A troca para `ativo` ou `isenta` volta a cota ao padrão da implantação só quando ela ainda é a do trial.
9. O registro de "já vi o tour" do portal é uma escrita como as outras e é recusado com o trial vencido; o tour volta a aparecer até o upgrade.
10. **O limite diário de e-mails** do item 8 da decisão de 2026-10-26 conta cada convite de colaborador e de portal criado ou reenviado (o reenvio cria um convite novo) pela agência no dia de Brasília: 20 no trial e 200 nos demais planos. A operação ajusta o limite de uma agência pelo comando interno, e o ajuste vale até ser desfeito. O banco conta sob uma trava por agência e, passado o limite, recusa o convite, que não é gravado nem enviado; a API responde `429` com "Limite diário de envios atingido. Tente amanhã." O convite de ativação da agência não conta.

**Consequência.** Estrutural, no molde da decisão de 2026-10-26: gatilhos em todas as tabelas de dados da agência, funções novas e a troca de três funções de convite e de notificação. Um módulo novo que crie tabela de dados da agência precisa ganhar o gatilho `00_<tabela>_agency_accepts_writes`. Os pedidos de LGPD (exportação e exclusão) ainda não existem no produto; quando existirem, entram na lista do item 1. Pede revisão de segurança independente.

**Origem.** Itens 1 a 3: revisão do #720, trazidos pelo maestro em 2026-10-26; o e-mail normalizado do item 2 e o item 10, revisão de segurança do PR #725, em 2026-10-27, que pediu seguir os itens 7 e 8 da decisão de 2026-10-26. Itens 4 a 9: derivados na implementação de #708, #709 e #714, escolhendo o caminho mais restritivo onde nada estava escrito.

**Validação.** Validada pelo dono em 2026-10-27.
