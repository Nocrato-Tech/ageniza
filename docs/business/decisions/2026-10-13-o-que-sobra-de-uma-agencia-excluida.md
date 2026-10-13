# O que sobra de uma agência excluída

**Data.** 2026-10-13

**Contexto.** A exclusão em 90 dias, ou a pedido, precisa apagar o tenant (LGPD), mas a lei fiscal exige guardar registros de cobrança, e a regra de um teste por conta e CPF precisa lembrar quem já fez teste.

**Decisão.** Sobram só:
- os registros de cobrança e fiscais necessários, cada tipo pelo prazo legal dele, conforme uma tabela de retenção validada com contador ou assessoria jurídica;
- o HMAC do CPF e do e-mail, com chave secreta protegida, para o "já usou o teste". Nunca um hash simples, porque CPF e e-mail se descobrem por tentativa;
- um registro mínimo de auditoria da exclusão (operação, data, resultado, motivo), sem copiar dado pessoal.

Todo o resto sai: clientes, conteúdo, mídia no armazenamento de objetos, conversas, vínculos e convites, e também índices, caches e backups, cada um com o prazo de expurgo documentado.

**Consequência.** Os backups precisam de prazo de expurgo documentado no runbook. O identificador HMAC continua sendo dado protegido.

**Origem.** Entrevista do módulo entrada, 2026-10-13.

**Validação.** Validada pelo dono em 2026-10-13.
