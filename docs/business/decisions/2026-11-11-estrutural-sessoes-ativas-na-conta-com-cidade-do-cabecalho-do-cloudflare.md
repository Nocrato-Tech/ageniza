# ESTRUTURAL: a conta lista as sessões ativas, deixa sair de uma ou das outras, e a cidade vem do cabeçalho do Cloudflare (#893)

**Data.** 2026-11-11

**Contexto.** O quadro do redesenho (r0) tem a página Conta com "Sessões ativas · 3 aparelhos" (navegador e sistema, cidade aproximada, "usando agora" ou "último uso", "Este aparelho", "Sair deste aparelho") e o cartão "Sair de todas as outras". A issue #893 pede isso. Hoje a API só tem `logout` (esta sessão) e `logout-all` (todas, inclusive a atual); a decisão [`2026-09-30-o-menu-de-conta-encerra-a-sessao-e-nao-troca-o-contexto`](2026-09-30-o-menu-de-conta-encerra-a-sessao-e-nao-troca-o-contexto.md) manda "Sair de todas as sessões" sempre aparecer no menu de conta. A sessão guarda o IP e o agente do navegador (`auth.session`: `ipAddress`, `userAgent`).

**Decisão.**

1. **Lista das próprias sessões.** A pessoa vê as sessões **dela**, em qualquer contexto (a sessão é global, não de agência): o navegador e o sistema (lidos do agente do navegador), a cidade aproximada quando existir, "Este aparelho" na sessão atual e, nas outras, o dia do último uso. Não se mostra o IP, nem o token, nem o identificador da sessão de outra pessoa.
2. **Sair de uma sessão.** "Sair deste aparelho" numa linha encerra **aquela** sessão (que não é a atual: a atual sai por "Sair"). Uma sessão de outra pessoa responde como se não existisse.
3. **Sair de todas as outras.** Encerra todas as sessões da conta **menos a atual**. A ação já existente de sair de todas (a atual inclusive) continua, no menu de conta.
4. **"Sair de todas" só com duas ou mais sessões.** No menu de conta, "Sair de todas as sessões" só aparece quando a pessoa tem 2 ou mais sessões ativas; com uma só, o menu tem só "Sair". Isso substitui "aparece sempre".
5. **A cidade vem do cabeçalho do Cloudflare.** Ao criar a sessão, a API lê o cabeçalho de localização do visitante que a borda põe (a cidade, `cf-ipcity`) e guarda **só o nome da cidade**, limpo e curto, na sessão. **Sem o cabeçalho, não se mostra cidade.** Não há serviço externo de geolocalização, base de IP local nem consulta do IP. A cidade é informativa: nenhuma decisão de segurança depende dela.
6. **"Usando agora" e "último uso".** A sessão atual é "Este aparelho"; as outras mostram o dia do último uso, que vem da renovação da sessão (no máximo a cada 24 horas de uso), então não é um relógio exato.
7. **A página Conta.** Nasce com o avatar, o nome, o e-mail, "Pedir troca de e-mail" e a lista de sessões. "Pedir troca de e-mail" sai do menu de conta para a página.

**Substitui.**

- A parte de [`2026-09-30-o-menu-de-conta-encerra-a-sessao-e-nao-troca-o-contexto`](2026-09-30-o-menu-de-conta-encerra-a-sessao-e-nao-troca-o-contexto.md) em que o menu de conta oferece "encerrar todas as sessões" sempre: a ação continua com confirmação e com o tratamento destrutivo, mas só aparece com 2 ou mais sessões. O resto dela (o menu mostra nome e e-mail, o 401 no logout, limpar o cache) continua valendo.
- O trecho "Menu de conta" de `specs/auth.md` (seção 7) no que põe "Pedir troca de e-mail" no menu.

**Consequência.**

- **É estrutural:** altera uma tabela que já existe (`auth.session` ganha a coluna da cidade) e muda a regra de sessão que o menu de conta e a remoção de acesso usam. **Migration:** coluna anulável de texto na sessão, sem backfill (sessões antigas ficam sem cidade). O IP já guardado continua sem sair da API.
- **Risco: Alto.** Autenticação, sessão e dado pessoal (a cidade aproximada é dado de localização). Pede revisão de segurança independente: a lista e o encerramento só alcançam sessões do próprio usuário (nunca outro, nem pelo identificador); "sair das outras" nunca encerra a atual; a cidade tem tamanho e caracteres limitados, e um cabeçalho forjado só muda o que a própria pessoa vê da própria sessão; a sessão some com o usuário.
- A SPEC é a seção 14 de `specs/auth.md`. Os fluxos mobile de entrada e do portal descrevem a página Conta.

**Origem.** Resposta do dono do produto em 2026-11-11 (issue #893) e decisão do maestro de que a cidade vem do cabeçalho do Cloudflare, sem serviço externo (risco 12 do inventário).

**Validação.** Validada pelo dono em 2026-11-12.
