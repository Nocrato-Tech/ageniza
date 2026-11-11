# Notificações

| | |
|---|---|
| **Status** | rascunho (decisões pendentes de validação do dono) |
| **Submódulos** | sino e lista da agência · eventos · lida e não lida |
| **Sessões** | 2026-11-11 |
| **Decidido por** | Pedro Vidal (dono do produto), com decisões do maestro pendentes de validação |

## 1. Propósito

Avisar a pessoa da agência, **dentro do app**, de cinco coisas que o cliente ou o tempo fizeram e que pedem a vez dela, com o estado de lida e não lida. Decisão: [`2026-11-11-estrutural-notificacoes-so-dentro-do-app-com-cinco-eventos`](../docs/business/decisions/2026-11-11-estrutural-notificacoes-so-dentro-do-app-com-cinco-eventos.md). É o primeiro mecanismo de notificação **dentro do produto**; a fila de e-mail de Conteúdo (seção 8 de `conteudo.md`) é outro mecanismo e não muda.

### Não resolve

- **E-mail novo, push e WhatsApp.** Nenhum. "Reenviar o link" e "Cobrar o cliente" só compartilham o endereço do portal.
- **Notificação para o portal.** A pessoa do portal não tem sino. O selo de "Pedidos da agência" é uma contagem de pedidos abertos, não uma notificação.
- **Preferências por tipo, silenciar, resumo diário.** Em aberto, com gatilho.
- **Apagar notificação** e **arquivar**.
- Eventos além dos cinco (publicação, comentário da agência, limite do plano).

## 2. Atores e autorização

Não há permissão nova. A notificação é **da pessoa que a recebe** e só ela a lê e a marca.

| capacidade | quem |
|---|---|
| Ver as próprias notificações, marcar como lida | a pessoa destinatária, com vínculo ativo na agência |
| Receber uma notificação de conteúdo | quem é responsável pelo conteúdo e ainda tem `conteudo.visualizar` |
| Receber a de pedido de material | quem abriu o pedido e ainda tem `cliente.visualizar` |
| Receber a de convite aceito | quem enviou o convite e ainda tem a permissão que o convite exige (`colaborador.visualizar` ou `cliente.convidar_usuario`) |

> Owner tem acesso total por posse. A autorização é validada no banco, na leitura, e não só no momento de criar.

Quem perdeu a permissão **não vê** a notificação (a policy confere a permissão na leitura), e o título do conteúdo não vaza. Quem foi removido da agência não tem vínculo e não lê nada.

## 3. Entidades e campos

### Notificação — `notifications` (tabela nova)

| campo | tipo | obrigatório | regra |
|---|---|---|---|
| `agency_id` | uuid | sim | o isolamento da RLS |
| `recipient_user_id` | uuid | sim | quem recebe; é por ele que a policy isola |
| `kind` | texto | sim | `content_approved`, `content_changes_requested`, `material_request_answered`, `approval_deadline_passed`, `invitation_accepted` |
| `content_id` | uuid | não | o conteúdo, nos quatro primeiros casos de conteúdo |
| `thread_id` | uuid | não | o pedido de material |
| `invitation_id` | uuid | não | o convite |
| `client_id` | uuid | não | o cliente, para o texto e o destino |
| `summary` | texto | sim | texto curto montado pelo servidor (até 160 caracteres), sem corpo de recado nem de comentário além de um trecho |
| `created_at` | timestamptz | sim | o instante do evento |
| `read_at` | timestamptz | não | preenchido quando a pessoa lê |

**Pertence a:** a pessoa e a agência. **Relações:** no máximo uma das três chaves de assunto (`content_id`, `thread_id`, `invitation_id`) por linha, por restrição.
**Unicidade:** uma notificação por `(recipient_user_id, kind, assunto, rodada)` para os eventos que podem repetir (o prazo vencido de uma mesma rodada notifica uma vez).

## 4. Estados e transições

```
não lida ─▶ lida      # a pessoa abre a notificação, ou "marcar todas como lidas"
```

Não há volta (lida não vira não lida) nem exclusão. **O que dispara cada notificação:**

| evento | quando | destinatário |
|---|---|---|
| `content_approved` | o cliente aprova (portal; o link de aprovação também) | responsável do conteúdo |
| `content_changes_requested` | o cliente pede ajuste | responsável do conteúdo |
| `material_request_answered` | o cliente comenta ou envia arquivo num pedido de material aberto | quem abriu o pedido |
| `approval_deadline_passed` | o instante do prazo da rodada passa e o conteúdo ainda aguarda | responsável do conteúdo |
| `invitation_accepted` | um convite de colaborador (ou de portal antigo) é aceito | quem enviou o convite |

A aprovação "fora da plataforma" feita pela agência **não** notifica (foi a própria agência). Uma aprovação desfeita pelo cliente não gera notificação nova.

## 5. Regras invioláveis

1. Uma notificação é **lida só pela pessoa destinatária**, na agência dela. Nenhuma outra pessoa, nem Admin nem Owner, lê a de outra.
2. A policy de leitura confere, **a cada leitura**, o vínculo ativo **e** a permissão do assunto; perder a permissão esconde a notificação.
3. **Ninguém cria notificação pela API de escrita direta.** Só as funções `security definer` de escopo único, chamadas **na mesma transação** do evento (aprovar, pedir ajuste, responder pedido, aceitar convite), e a função do trabalho diário do prazo vencido. O `INSERT` não é concedido ao papel da aplicação.
4. A notificação do evento nasce **ou todo o evento acontece**: se a transação do evento falha, não há notificação; se a notificação falhar, o evento não é perdido (a função é tolerante a destinatário ausente: sem responsável, não notifica, e não derruba a aprovação).
5. `read_at` é fixado pelo banco (função), nunca enviado pelo cliente; só a própria pessoa o escreve.
6. Nada é enviado por e-mail nem push; nenhum corpo de comentário, recado ou arquivo entra no `summary` além de um trecho curto.
7. Cliente arquivado e agência suspensa **não geram** notificação nova.
8. O trabalho do prazo vencido é idempotente: roda mais de uma vez sem duplicar.

## 6. Backend

### Rotas

Todas sob `requireAgencyAccess`.

| método | rota | permissão | devolve |
|---|---|---|---|
| `GET` | `/agencies/:agencyId/notifications` | a própria pessoa | lista paginada (contrato de listagem, 20 por página), da mais recente à mais antiga; filtro `unread=true` |
| `GET` | `/agencies/:agencyId/notifications/unread-count` | a própria pessoa | `{ data: { count } }`, usado para o ponto do sino |
| `POST` | `/agencies/:agencyId/notifications/:notificationId/read` | a própria pessoa | `204`; notificação de outra pessoa é `404` |
| `POST` | `/agencies/:agencyId/notifications/read-all` | a própria pessoa | `204`; marca as da pessoa nessa agência |

Cada item: `id`, `kind`, `summary`, `createdAt`, `readAt`, o destino (`{ type: 'content' \| 'material-request' \| 'collaborators', clientId?, contentId?, threadId? }`). **Contrato proposto** em `packages/contracts/src/notifications.ts`, estrito.

### Persistência

Tabela nova `notifications` (seção 3), com índice por `(recipient_user_id, agency_id, created_at desc)` e outro parcial para as não lidas. Grants por coluna: `SELECT`; `UPDATE` só em `read_at` (por função); nenhum `INSERT` nem `DELETE` para o papel da aplicação. Funções novas: criar a notificação (uma por evento, chamadas pelas funções que já existem de aprovar, pedir ajuste, comentar pedido, aceitar convite), `read_notification`, `read_all_notifications` e a do prazo vencido.

### RLS

- **Agência:** `SELECT` quando `recipient_user_id` é a pessoa ligada na transação e há vínculo ativo na agência; para os assuntos de conteúdo, `app_private.has_agency_permission(agência, 'conteudo.visualizar')`; para o pedido, `cliente.visualizar`; para o convite, a permissão do tipo.
- Nenhuma policy deixa um vínculo de cliente satisfazer a leitura: o portal não vê nem uma notificação.
- RLS ativa e forçada, como toda tabela de `public`.

## 7. Frontend

### Telas

| tela | rota | o que mostra | quem acessa |
|---|---|---|---|
| Sino | na barra superior | o ponto quando há não lidas; abre o painel | qualquer pessoa da agência |
| Notificações | painel do sino e página `/agencia/:agenciaId/notificacoes` | a lista, "Marcar todas como lidas" | a própria pessoa |

### Esboço

```
┌─ Notificações ──────────────── Marcar todas como lidas ┐
│ ● Rosana aprovou "Promoção de pães"          há 5 min │
│ ● Café Central pediu ajuste em "Reels de maio"  1 h   │
│   Rosana respondeu "Fotos da equipe"        ontem     │
│   O prazo de "Cardápio" venceu              ontem     │
│   Ana aceitou o seu convite                 2 dias    │
└────────────────────────────────────────────────────────┘
```

| elemento | função |
|---|---|
| Sino com ponto | o ponto aparece com `count > 0`; o `IconButton` ganha a propriedade `dot`; o rótulo diz "N notificações não lidas" |
| Item | o ícone do tipo, o texto, o tempo; não lida em destaque (ponto e peso, nunca só cor). Abrir marca como lida e leva ao destino (o conteúdo no calendário, o pedido na Visão geral do cliente, a Equipe) |
| "Marcar todas como lidas" | uma ação, no cabeçalho do painel |

A contagem se atualiza ao voltar o foco à aba e a cada 60 segundos; não há conexão aberta nem push.

### Variação por papel

Sem variação de tela: quem não pode ler o assunto não recebe a notificação. Quem não é responsável por nada vê "Nada novo por aqui" até um convite aceito.

### Estados da tela

- **Vazio (boa notícia):** "Nada novo por aqui", com o visto, só quando a consulta respondeu.
- **Carregando:** skeleton na forma da linha.
- **Erro:** "Não foi possível carregar as notificações", com "Tentar de novo"; o sino continua sem ponto, e não diz "nada novo".
- **Sem permissão:** não existe: o sino aparece para todos e a lista só tem o que a pessoa lê.

## 8. Infraestrutura

Um **trabalho diário** do worker (`notifications.approval-deadline-passed`), no molde de "Trabalho agendado sem requisição" de [`structural-changes.md`](../docs/business/structural-changes.md): chama uma função `security definer` de escopo único, auditada, que cria a notificação das rodadas cujo prazo (`due_at`) já passou, para conteúdo que ainda aguarda, sem duplicar. Roda de hora em hora, para o prazo com hora ser avisado perto do instante. Sem e-mail, sem fila nova.

## 9. Impacto estrutural

- [ ] altera tabela que já existe (as funções de aprovar, pedir ajuste, comentar pedido e aceitar convite **ganham uma chamada**, mas nenhuma tabela existente muda)
- [x] muda formato de resposta que outras rotas copiam (o primeiro "evento dentro do app" que os próximos copiam)
- [x] mexe em RLS de mais de um módulo (a permissão do assunto de cada notificação cruza conteúdo, clientes e colaboradores)
- [x] muda como a autorização é avaliada (a leitura confere a permissão do assunto, a cada leitura)
- [ ] exigiria backfill

Registrada como estrutural em [`2026-11-11-estrutural-notificacoes-so-dentro-do-app-com-cinco-eventos`](../docs/business/decisions/2026-11-11-estrutural-notificacoes-so-dentro-do-app-com-cinco-eventos.md). **Risco Alto:** pede revisão de segurança independente (leitura de notificação de outra pessoa, de outra agência e de assunto cuja permissão se perdeu; `INSERT` direto; evento que falha com a notificação).

## 10. Em aberto

| ponto | gatilho | quem decide |
|---|---|---|
| Preferências de notificação por tipo | a primeira pessoa pedir para silenciar um tipo | Pedro Vidal |
| E-mail ou push para os mesmos eventos | o primeiro pedido de ser avisado fora do app | Pedro Vidal |
| Retenção: apagar as lidas com mais de N dias | a tabela passar de um milhão de linhas, ou a primeira exigência de retenção de dado pessoal | Pedro Vidal |
| Notificar o portal (por exemplo, "a agência respondeu") | o primeiro cliente pedir para ser avisado de uma resposta | Pedro Vidal |
| Agrupar a aprovação de um lote em uma notificação | uma agência receber mais de 20 notificações de um só lote | Pedro Vidal |

## 11. Decisões registradas

- [`2026-11-11-estrutural-notificacoes-so-dentro-do-app-com-cinco-eventos`](../docs/business/decisions/2026-11-11-estrutural-notificacoes-so-dentro-do-app-com-cinco-eventos.md)
- [`2026-11-11-estrutural-o-prazo-de-aprovacao-tem-hora-e-padrao-de-48-horas`](../docs/business/decisions/2026-11-11-estrutural-o-prazo-de-aprovacao-tem-hora-e-padrao-de-48-horas.md) (o instante do prazo vencido)
- [`2026-11-11-estrutural-a-rodada-de-aprovacao-mostra-ao-cliente-quem-enviou-e-aceita-recado-ao-aprovar`](../docs/business/decisions/2026-11-11-estrutural-a-rodada-de-aprovacao-mostra-ao-cliente-quem-enviou-e-aceita-recado-ao-aprovar.md) (o recado que acompanha a aprovação)
- Herdadas: a fila de e-mail de Conteúdo ([`2026-11-10-estrutural-lembretes-de-aprovacao-vence-amanha-e-venceu`](../docs/business/decisions/2026-11-10-estrutural-lembretes-de-aprovacao-vence-amanha-e-venceu.md)), que segue como está.

## 12. Recorte de implementação

Ainda não recortado em issues (a onda do redesenho não abre issue, por decisão do dono em 2026-11-11). Quando for, a seção 12 recebe os números.

**History:** a agência é avisada, dentro do app, do que o cliente fez.

| task | escopo | depende de |
|---|---|---|
| Migration: tabela, índices, grants e policies; funções dos cinco eventos | `db` | a migration do prazo com hora |
| Módulo `notifications` da API: listar, contar, marcar | `api` | a migration |
| Chamar a função de notificação em aprovar, pedir ajuste, comentar pedido e aceitar convite | `api` | a migration |
| Trabalho do prazo vencido | `infra` | a migration |
| Sino, painel e página de notificações; `IconButton` com ponto | `web` | a API |
