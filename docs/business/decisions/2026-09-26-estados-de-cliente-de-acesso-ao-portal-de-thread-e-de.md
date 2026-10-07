# Estados de cliente, de acesso ao portal, de thread e de persona

**Data.** 2026-09-26

**Contexto.** O banco já corta o portal de cliente arquivado — `requireClientAccess` devolve 404 — e já recusa o aceite de convite de cliente arquivado. Não mexe nos vínculos ao arquivar, e um convite aceito por alguém removido reativa o vínculo antigo.

**Decisão.**

- **Arquivar o cliente** corta o portal na requisição seguinte, **revoga os convites pendentes** no ato e **preserva os vínculos**, de modo que reativar devolve o acesso a quem já tinha. Não há pré-condição: arquiva-se com thread aberta, persona ou o que houver. Revogar evita que um link antigo volte a valer sozinho na reativação.
- **Cliente arquivado é somente leitura** na área da agência: aparece pelo filtro de status e mostra tudo, mas não se edita, não se comenta e não se convida. A única ação é **reativar**.
- **Pessoa do portal**: `active → removed` tira o acesso dela na requisição seguinte, sem afetar as demais. Volta por **reativação direta** pelo Admin, como em Colaboradores; o caminho por convite novo continua existindo.
- **Thread**: aberta ↔ resolvida. Só a agência resolve; **comentário novo reabre**, de qualquer lado. Não existe ação separada de reabrir — o único jeito é dizer por quê.
- **Persona**: ativa ↔ arquivada. Arquivada some do estudo que o cliente vê, suas threads ficam somente leitura, e quem tem `cliente.operar` a desarquiva.

**Consequência.** Arquivar cliente com conteúdo agendado é pergunta que só existe quando Conteúdo existir, e é tratada entre as regras invioláveis desta entrevista.

**Origem.** Decidido em sessão (entrevista do módulo de clientes).

