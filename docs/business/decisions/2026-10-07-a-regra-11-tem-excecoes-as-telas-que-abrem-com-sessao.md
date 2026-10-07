# A regra 11 tem exceções: as telas que abrem com sessão válida sem redirecionar

**Data.** 2026-10-07

**Contexto.** A regra 11 e a tabela da §7 diziam "qualquer tela deste módulo redireciona ao contexto ativo", sem exceção escrita, e o código nunca redirecionou `/senha/redefinir`, `/convite/:token` e `/email/confirmar` — a divergência foi achada na auditoria de fechamento do módulo (issue #342). Cada uma dessas telas precisa abrir justamente para quem já tem sessão: o convite é aceito por quem está logado (§7, Convite, com o aceite automático decidido em 2026-10-07), e os links de redefinir senha e de confirmar e-mail chegam por e-mail e podem ser de outra conta — inclusive de uma sessão aberta no mesmo navegador. As páginas de Termos e Privacidade são públicas por definição.

**Decisão.** Ficam **sem redirecionamento**, mesmo com sessão válida: `/convite/:token`, `/senha/redefinir`, `/email/confirmar`, `/termos` e `/privacidade`. As demais telas do módulo (`/entrar`, `/sem-acesso`, `/senha/esquecida`) continuam redirecionando ao contexto ativo, como já faziam.

**Consequência.** A regra 11 e a tabela de estados da §7 passam a listar as exceções com o motivo, e cada exceção tem teste de "com sessão válida, a tela abre e não redireciona"; as telas comuns continuam cobertas pelo teste de redirecionamento (o de `/entrar` já existia). Nenhuma rota, contrato ou API muda: é regra de navegação e a SPEC que estavam desalinhadas. Reabre quem voltar a redirecionar uma dessas telas.

**Origem.** Issue #342, decisão do maestro com autonomia dada pelo dono do produto em 2026-10-07. **Pendente de validação** pelo dono do produto.

