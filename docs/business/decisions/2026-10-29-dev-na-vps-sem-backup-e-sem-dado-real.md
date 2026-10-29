# O dev na VPS não tem backup e nunca recebe dado real de cliente

**Data.** 2026-10-29

**Contexto.** O ambiente de dev na VPS (decisão `2026-10-29-estrutural-ambiente-de-dev-na-vps`) guarda contas, convites, conteúdos e mídia criados para testar o produto. O backup diário do banco, cifrado para o R2, cobre a produção e custa espaço, rotação de chave e um ensaio de restauração.

**Decisão.** Os dados do dev são descartáveis: o dev não entra no backup diário, e perder o banco do dev é um incidente sem consequência para clientes. Em troca, nenhum dado real de agência, cliente ou pessoa entra no dev: nem cópia da produção, nem importação, nem conta de pessoa de fora. O dev usa buckets R2 próprios, com tokens que só alcançam esses buckets, e um segredo de autenticação próprio.

**Consequência.** Refazer o dev é recriar o volume e rodar as migrations. O deploy recusa um `runtime.env` cujos buckets não tenham `dev` no nome. A primeira agência-piloto, ou qualquer dado real, só entra na produção.

**Origem.** Desenho do ambiente de dev na VPS (issue #774), tomado pelo implementador a partir da decisão do dono.

**Validação.** Pendente de validação do dono.
