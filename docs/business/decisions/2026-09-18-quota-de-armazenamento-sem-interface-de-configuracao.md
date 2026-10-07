# Quota de armazenamento sem interface de configuração

**Data.** 2026-09-18

**Contexto.** Nenhuma issue pediu administração de quota.

**Decisão.** Existe um padrão por ambiente e um override por agência em `agency_storage_quotas`. O ajuste é feito direto no banco pela operação.

**Consequência.** Mudar a quota de um cliente exige acesso ao banco. Não há registro de quem mudou nem quando.

**Origem.** PR #40. **Pendente de validação.**

