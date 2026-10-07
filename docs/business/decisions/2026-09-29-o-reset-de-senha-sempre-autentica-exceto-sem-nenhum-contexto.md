# O reset de senha sempre autentica, exceto sem nenhum contexto
**Data.** 2026-09-29

**Contexto.** `specs/auth.md` (§7, "Redefinir senha") já decidia que, ao final do reset, a pessoa **já está autenticada** — segue para o aceite do convite quando houver um, ou para o `resolve`. A API só cumpria isso no ramo **com** `inviteToken`: `POST /auth/password/reset` sem convite respondia `204` sem cookie, e não havia como a tela cumprir esse aceite. A divergência foi achada pela #73, ao tentar implementar a tela de reset contra o contrato real.

**Decisão.** `POST /auth/password/reset` sempre autentica quem redefiniu, pelo mesmo mecanismo `signInEmail` que o ramo com convite já usava — **exceto** a mesma exceção que já vale para o login (2026-09-24, "Credencial correta sem nenhum contexto não cria sessão"): conta com **zero contextos** e sem `inviteToken` válido para o mesmo e-mail. Nesse caso a senha é trocada (a redefinição em si nunca deixa de acontecer, regra 8), mas **nenhuma sessão é criada** — se o mecanismo do Better Auth chegar a criar uma, ela é revogada pelo mesmo caminho que o login já usa (issue #68), e nenhuma linha sobrevive em `auth."session"`.

A resposta passa a ser sempre `200`, com corpo que diz o que aconteceu: `{ signedIn: true }` quando há sessão, `{ signedIn: false, reason: 'NO_CONTEXT_ACCESS' }` quando não há. O `400 INVALID_LINK` de token de reset inválido, usado ou expirado não muda. A resposta não vira oráculo de existência de conta além do que um token de reset **válido** já prova — quem chegou até aqui já provou o e-mail pelo link.

`AuthLoginRequestSchema`, em `packages/contracts/src/auth.ts`, passa a declarar o `inviteToken` opcional que a rota de login já aceitava desde a decisão de 2026-09-29 anterior ("O login aceita o token do convite..."), mas que só existia como extensão local em `routes.ts` — o web enviava esse campo fora do que o contrato validava.

**Consequência.** É **mudança de contrato numa rota implantada**: o `204` sem corpo, fora do ramo de convite, deixa de existir; os testes de integração de `password/reset` mudaram junto. Não há migration nem policy nova — reaproveita `countValidContexts` (injetado do módulo `contexts`) e a mesma rotina de revogação que o login já tinha.

**Origem.** Issue #175, achado registrado pela #73. Decidido pelo dono do produto em sessão, em 2026-09-29.

**Correção pós-revisão (2026-09-29, PR #176).** A revisão de segurança achou que a primeira versão confundia dois casos sob um único motivo: `signedIn: false, reason: 'NO_CONTEXT_ACCESS'` também saía quando a conta **tinha** contexto e a assinatura pós-reset falhava por outro motivo — reproduzido com uma falha transitória na contagem de contextos e com dois tokens de reset válidos da mesma conta usados em paralelo (o segundo perde a corrida pela senha atual e recebe o motivo errado). Havia ainda um caso em que a contagem falhando **depois** da assinatura deixava uma sessão órfã no banco (nunca alcançável pelo cliente, mas contrariando "nenhuma sessão sobrevive").

A correção: a contagem de contextos passa a rodar **antes** da assinatura, não depois — uma conta confirmada em zero contextos nunca chega a ter sessão criada para revogar, o que também fecha o caso da sessão órfã. E `signedIn: false` passa a ter dois motivos: `NO_CONTEXT_ACCESS` fica reservado ao zero **confirmado** pela contagem; qualquer outra causa que impeça a sessão — conta não identificável, contagem falhando, ou a própria assinatura falhando — usa `reason: 'SIGN_IN_REQUIRED'`, e a tela leva a `/entrar` em vez de `/sem-acesso`. A senha muda nos dois casos; a distinção é só sobre o próximo passo da pessoa. `AuthPasswordResetResponseSchema`, `specs/auth.md` (regra 8a, §6, §7) e o README do módulo `auth` foram atualizados juntos. Toda falha nesse caminho passa a gerar um log estruturado (sem senha, token ou e-mail), onde antes o `catch` era silencioso.

**Origem da correção.** Revisão de segurança do PR #176 (issue #175); decisão do dono do produto em sessão, em 2026-09-29.

