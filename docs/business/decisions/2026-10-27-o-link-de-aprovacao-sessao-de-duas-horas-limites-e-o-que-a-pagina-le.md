# O link de aprovação: sessão de duas horas, limites e o que a página lê

**Data.** 2026-10-27

**Contexto.** A decisão de 2026-10-26 sobre o link de aprovação deixa números e formas em aberto ("validade curta", "limites de tentativa por IP", "URL assinada de minutos") e o #712 precisou escolher cada um para implementar a API e o banco. A tela é a #717, de outro agente, e depende destes valores.

**Decisão.**

1. **A sessão de aprovação dura 2 horas e nunca passa do link** (que vale 7 dias, contados da emissão, e no máximo 7 por `check` da tabela). Depois dela, o token do e-mail abre uma sessão nova enquanto o link valer.
2. **O cookie** chama-se `ageniza_approval` e é `HttpOnly`, `SameSite=Strict`, com `Max-Age` igual ao que resta da sessão, sem `Domain`, e `Secure` onde `APP_PUBLIC_URL` é HTTPS. O `Path` é o das rotas do link, `/portal-approval`, ou `/api/portal-approval` em produção, onde o servidor web serve a API sob `/api` e o navegador só devolve o cookie ao caminho que viu. O valor é a sessão (32 bytes em base64url), e o banco guarda o hash.
3. **O token vai só no corpo de um POST** (`POST /portal-approval/session`, 43 caracteres base64url). Nenhuma rota do link aceita consulta: qualquer parâmetro na URL é `400`, o token inclusive, para ele não parar num log por engano.
4. **Limites**, em memória do processo e por janela fixa, contando também o que foi recusado: a troca, 30 por IP e 10 por token a cada 15 minutos; as decisões, 60 por IP e 30 por sessão a cada 15 minutos; as leituras, 300 por IP e 120 por sessão a cada 5 minutos. A chave é o IP ou o hash, nunca o valor. Excedido, `429 RATE_LIMITED` com `Retry-After`.
5. **A URL assinada da mídia** vale no máximo 5 minutos, ainda que a implantação permita mais para o portal, e não grava evento de auditoria por pessoa (não há conta).
6. **O lote** é o dos conteúdos do e-mail, e a página lê todos no estado de agora: o decidido aparece com o estado e sem botões (`canDecide: false`), o que voltou a aguardar aprovação continua, o em produção vira título, dia e formato, e o cancelado some. Decidir segue as regras do portal: aprovar o já aprovado não muda nada e a primeira aprovação fica; fora de "aguardando aprovação", `409`; revisão que mudou, `409`; comentário em branco, `400`.
7. **A revogação não tem coluna.** O `revoked_at` da decisão de 2026-10-26 não existe: o link morre pela conferência a cada uso (acesso removido ou de outra geração, cliente arquivado, agência suspensa ou somente leitura, link ou sessão vencidos), e os erros do banco `A0100` (link morto) e `A0090` (agência somente leitura, na escrita) viram o mesmo `404 APPROVAL_LINK_INVALID`, sem dizer o motivo.
8. **Duas contas na mesma caixa** (o caso da decisão de 2026-10-27 sobre a fila) recebem um e-mail com um link só, emitido para o acesso de menor id, com os conteúdos dos dois. A decisão é gravada como esse acesso.
9. **A página do link** é `APP_PUBLIC_URL/aprovar#<token>`. A resposta do lote traz o endereço do acesso (`personEmail`) para o "Criar conta para ver o portal" levar a `/criar-conta` com ele preenchido, e nunca diz se o endereço já tem conta.
10. **A agência lê o "aprovado por" do link** como `{ name, side: "client", viaLink: true }`, com o e-mail do acesso enquanto a conta não entrou no portal.
11. **O texto do e-mail** de "conteúdos para aprovar" troca o link do portal pelo do lote e avisa que ele vale 7 dias e é pessoal. O e-mail do resumo de "publicados" continua com o portal.

**Consequência.** Os valores acima ficam em `apps/api/src/modules/approval-links/policy.ts` e nas funções da migration `20261027090200`. Não há expurgo de links vencidos nem de sessões (cada e-mail de aprovação cria uma linha pequena; a limpeza fica para a rotina de retenção). O contador de limites é por processo: com mais de uma instância da API, cada uma conta o seu.

**Origem.** Valores e formas derivados pelo implementador na issue #712, a partir dos itens 1 a 9 da decisão de 2026-10-26 e das revisões do #720, #725 e #728.

**Validação.** Pendente de validação do dono.
