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

- **Sessão em cookie httpOnly** (`SameSite=lax`), emitido por `POST /auth/login`. Não há token no corpo nem na URL.
- **Origin conferido** em toda escrita: requisição sem `Origin` ou com outro valor recebe `403 CSRF_REJECTED`.
- **O tenant vai na rota**: `/agencies/:agencyId/...` para a equipe, `/clients/:clientId/...` para o portal. A guarda revalida o vínculo a cada chamada.
- **404 indistinto**: agência ou cliente inexistente, suspenso ou fora do alcance devolve `404`, nunca `403`.
- **Erro sempre no mesmo formato**: `{ "error": { "code", "message" }, "meta": { "requestId" } }`. Use o `code` para decidir o que mostrar; a `message` em português é a que o produto mostra.
- **Permissões**: `GET /agencies/:agencyId/me` devolve as permissões efetivas do contexto. Use para esconder ações; o backend recusa de qualquer jeito.

## 3. O que falta no backend para o app

O backend foi feito para o navegador. Antes do primeiro login no app, ele precisa de:

1. **Sessão fora do navegador.** O app não guarda cookie httpOnly sozinho. O Better Auth (a biblioteca de auth do backend) tem suporte para Expo, que guarda a sessão no SecureStore e a envia em cada chamada.
2. **Origin do app.** Incluir o esquema do app (ex.: `ageniza://`) nas origens confiáveis, senão toda escrita volta `403 CSRF_REJECTED`.
3. **Google por deep link.** Hoje `GET /auth/callback/google` redireciona para `/entrar/google` na web; o app precisa voltar para ele mesmo.
4. **Links de e-mail abrindo o app** (opcional): os e-mails apontam para a web (`/email/verificar?token=`, `/convite/:token`, `/aprovar#<token>`, `/senha/redefinir?token=`). Para abrir no app, configurar universal links / app links para esses caminhos.

Isso mexe em autenticação e passa pela revisão de segurança do backend. Peça por issue no repositório com o que o app precisa; não altere o backend pelo lado do app.

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
