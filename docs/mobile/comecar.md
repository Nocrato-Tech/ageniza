# Começar o projeto mobile

## 1. Ambientes

| ambiente | API | para quê |
|---|---|---|
| dev | `https://dev.ageniza.com.br` | backend real do branch `develop`, atualizado a cada merge; contas de teste pedidas ao dono |
| local | `http://127.0.0.1:3001` | rodar o backend na máquina: [docs/local-environment.md](../local-environment.md) |

- Saúde da API: `GET /health` (processo vivo) e `GET /ready` (pronta para tráfego).
- A documentação interativa da API (`/docs`) só existe no ambiente local (`pnpm dev`).
- Os e-mails do ambiente de dev (confirmação, convite, aprovação) caem numa caixa interna protegida; o acesso é liberado por e-mail pelo dono.
- Os planos pagos no dev usam um provedor **simulado**: `POST /agencies/:agencyId/subscription/charges/:chargeId/simulated-payment` paga e `POST /agencies/:agencyId/subscription/simulated-period-advance` avança o relógio. Essas rotas não existem em produção.

## 2. Como a API autentica hoje

- **Sessão em cookie** (`httpOnly`, `SameSite=lax`), emitido por `POST /auth/login`. Não há token no corpo nem na URL. O navegador o guarda sozinho; o app o guarda e o devolve (seção 3).
- **Origin conferido** em toda escrita: requisição sem `Origin` ou com outro valor recebe `403 CSRF_REJECTED`. O app se identifica por `expo-origin` (seção 3).
- **O tenant vai na rota**: `/agencies/:agencyId/...` para a equipe, `/clients/:clientId/...` para o portal. A guarda revalida o vínculo a cada chamada.
- **404 indistinto**: agência ou cliente inexistente, suspenso ou fora do alcance devolve `404`, nunca `403`.
- **Erro sempre no mesmo formato**: `{ "error": { "code", "message" }, "meta": { "requestId" } }`. Use o `code` para decidir o que mostrar; a `message` em português é a que o produto mostra.
- **Permissões**: `GET /agencies/:agencyId/me` devolve as permissões efetivas do contexto. Use para esconder ações; o backend recusa de qualquer jeito.

## 3. Como o app entra

O backend foi feito para o navegador; para o app nativo ele ganhou três coisas, todas ligadas por `MOBILE_APP_ORIGINS` (a lista de esquemas de deep link que a API reconhece, ex.: `ageniza://`). **Vazia, a API se comporta como antes e recusa o app** com `403 CSRF_REJECTED`. No dev o dono liga o esquema do app no `runtime.env`; para a produção, peça ao dono.

1. **Sessão fora do navegador.** A sessão é o mesmo cookie de sempre, mas quem o guarda é o app. Guarde os `Set-Cookie` das respostas (`expo-secure-store`) e mande-os de volta no cabeçalho `Cookie` de toda chamada. O pacote `@better-auth/expo` (use a mesma versão do `better-auth` do backend) traz o cliente `expoClient` e as funções `getSetCookie` / `getCookie` para isso; configure `cookiePrefix: 'ageniza'`, que é o prefixo dos cookies desta API. As regras da sessão não mudam: expira, é revogada ao remover o colaborador e no "sair de todos os aparelhos", e conta não confirmada recebe `403 EMAIL_NOT_CONFIRMED`.
2. **Origin do app.** Toda escrita precisa dizer de onde vem. O app manda o cabeçalho `expo-origin: ageniza://` (o `expoClient` já faz isso; no código próprio, ponha na mão). A API só aceita `expo-origin` quando a requisição não traz `Origin`, e só para um esquema da lista; qualquer outro valor volta `403 CSRF_REJECTED`. Use um *development build* com esquema próprio: o Expo Go usa o esquema `exp://`, que não está na lista.
3. **Google por deep link.** Abra `GET /auth/google/start?appRedirect=<deep link do app>` num navegador do sistema (`WebBrowser.openAuthSessionAsync`), com o mesmo deep link como URL de retorno, por exemplo `ageniza://auth/google`. O esquema do deep link precisa estar na lista; outro valor volta `400 VALIDATION_ERROR` antes de chegar ao Google. Ao fim, o navegador devolve o app para o deep link:
   - **sucesso:** `ageniza://auth/google?cookie=<Set-Cookie>`; grave o cookie como no item 1 e siga com `GET /auth/session`;
   - **falha:** `ageniza://auth/google?erro=google`, sem motivo (a mesma mensagem de senha errada).
   Sem `appRedirect`, o fluxo é o da web e termina na tela `/entrar/google`.
4. **Links de e-mail abrindo o app** (opcional, ainda não existe): os e-mails apontam para a web (`/email/verificar?token=`, `/convite/:token`, `/aprovar#<token>`, `/senha/redefinir?token=`). Para abrir no app, configure universal links / app links para esses caminhos. Peça por issue.

**Cuidado com o deep link.** Um esquema próprio (`ageniza://`) não é exclusivo: outro app instalado no aparelho pode registrar o mesmo esquema e ler o cookie que o Google devolve (só o retorno do Google leva o `?cookie=`; e-mail e senha recebem `Set-Cookie`). Universal links / App Links **não** resolvem, porque o plugin não anexa a sessão a destino `http(s)`. Por isso a lista fica só no dev até a issue #799 (código de uso único com PKCE, ou Google Sign-In nativo com `idToken`). A decisão está em [autenticação para o cliente nativo](../business/decisions/2026-10-29-estrutural-autenticacao-para-cliente-nativo.md).

Mudou algo na autenticação que o app precisa? Isso passa pela revisão de segurança do backend: peça por issue com o que o app precisa; não altere o backend pelo lado do app.

## 4. Onde o app pode morar

| opção | prós | contras |
|---|---|---|
| **Dentro do monorepo** (`apps/mobile`) | importa os tipos de `packages/contracts` direto; mudança de contrato quebra o build do app na hora; um só lugar para issues e CI | precisa conviver com o pnpm/turbo do repositório e com as regras de PR dele |
| **Repositório próprio** | ritmo e ferramentas independentes | cliente gerado do `openapi.json`, que precisa ser regerado a cada mudança; quebra de contrato aparece só em tempo de execução |

A escolha é do time mobile.

## 5. Compatibilidade da API

App de loja fica instalado em versões antigas por meses. Por isso:

- A API **só adiciona** campos e rotas. Remover ou renomear um campo que o app usa quebra quem não atualizou.
- Ignore campos desconhecidos na resposta e não dependa da ordem deles.
- Precisa de um campo, de uma resposta mais leve ou de uma rota nova? Abra uma issue descrevendo a tela e o dado. As listas já são paginadas; variantes enxutas entram quando uma tela real pede.

## 6. Regras que o app precisa respeitar desde o início

- **Conta não confirmada não abre nada**: até confirmar o e-mail, as rotas de tenant respondem `403 EMAIL_NOT_CONFIRMED`.
- **Termos e Privacidade**: com versão nova pendente, as rotas respondem `403 TERMS_NOT_ACCEPTED`; leve a pessoa ao aceite ([Entrada](fluxos/entrada.md#termos-e-privacidade)).
- **Agência em modo leitura** (teste vencido ou plano encerrado): escritas respondem `409 AGENCY_READ_ONLY`. Mostre o aviso de renovação e desabilite as ações; só remover colaborador, remover acesso ao portal e cancelar convite continuam.
- **Limites do plano**: `409 TRIAL_CLIENT_LIMIT`, `409 PLAN_CLIENT_LIMIT`, `409 TRIAL_COLLABORATOR_LIMIT`; convites também podem responder `429 DAILY_EMAIL_LIMIT`.
- **O portal nunca vê trabalho interno** (subtarefa, responsável, prazo interno, roteiro em rascunho): a API já não devolve; não tente montar isso no app.
