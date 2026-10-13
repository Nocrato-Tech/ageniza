# Entrada

| | |
|---|---|
| **Status** | aprovado |
| **Submódulos** | cadastro público e teste grátis · planos e limites · assinatura e pagamento · ciclo de vida comercial da agência · operação · landing e contrato de planos |
| **Sessões** | 2026-10-13 |
| **Decidido por** | Pedro Vidal, em sessão; SPEC aprovada em 2026-10-13 |

> **Implementação adiada até a validação do MVP** ([decisão](../docs/business/decisions/2026-10-13-a-entrada-self-service-espera-a-validacao-do-mvp.md)). Esta SPEC é o desenho aprovado, mas nenhuma issue foi gerada: até o gatilho, a agência entra pelo comando interno, como hoje, e a decisão de 2026-09-15 continua sendo a prática vigente. Antes de retomar, revisar preços, limites e o recorte à luz do uso real.
>
> **Esta SPEC reabre duas decisões anteriores.** "Entrada de agências apenas por comando interno" (2026-09-15, #32) deixa de valer na parte "não existe cadastro público"; o resto dela (a CLI roda fora do RLS e nunca imprime o token) continua. E o gatilho de "Cobrança existe no plano do produto, não no sistema" (2026-09-24) aconteceu: pela primeira vez um limite é imposto por plano. A SPEC de [auth](auth.md) ("Cadastro público não existe e não vai existir", `disableSignUp: true`) e o [product-overview](../docs/business/product-overview.md) ("Não é um produto de autoatendimento") precisam ser atualizados junto com esta SPEC.
>
> **O que já existe e é reaproveitado:** o estado `active`/`suspended` da agência (lido em 88 pontos de 21 migrations), o Owner como coluna da agência (`owner_user_id`), o comando `pnpm cli:agency`, o limitador de auth (`apps/api/src/modules/auth/auth-limiter.ts`), a cota de mídia por agência (`agency_storage_quotas` + `app_private.agency_media_usage`), o aceite versionado de Termos e Privacidade, o seletor de contexto e a fila de notificação por e-mail.
>
> Herda de [`autorizacao.md`](autorizacao.md): o contrato de listagem, "sem permissão" não é tela, `archived`/`removed`. Os dias são contados no dia de São Paulo, como no resto do produto (fuso por agência é o em aberto #153).

## 1. Propósito

Deixar qualquer agência chegar pela landing, criar a conta sozinha, usar um teste grátis de 14 dias com limites, e passar a pagar dentro do produto, sem depender da operação. O backend leva a agência pelo ciclo comercial inteiro (teste, paga, em atraso, cancelando, suspensa, excluída), e é ele quem aplica cada prazo.

### Não resolve

- **Emissão de nota fiscal, cupom ou desconto, moeda estrangeira, troca de dono da agência, reembolso pelo produto, ciclo anual, mudança de plano com cálculo proporcional.** Fora do lançamento — seção 10.
- **Login com Google.** Seção 10.
- **Painel de operação.** A operação age por comando interno — seção 10.
- **Construtor visual ou CMS da landing.** Seção 10.
- **Modo leitura para agência que não paga.** Não existe: ela é suspensa.
- **Excedente cobrado por uso medido.** O adicional é comprado em unidade, com preço fixo.

## 2. Atores e autorização

| capacidade | permissão | Owner | Admin | demais | portal | operação (CLI) | provedor (webhook) |
|---|---|:-:|:-:|:-:|:-:|:-:|:-:|
| ver plano, uso, limites, adicionais e histórico de cobrança | `assinatura.visualizar` (preset Admin) | ✅ | ✅ só leitura | só a mensagem do limite | — | ✅ | — |
| escolher plano e pagar | posse (Owner) | ✅ | — | — | — | — | — |
| comprar ou remover adicional | posse (Owner) | ✅ | — | — | — | — | — |
| trocar de plano, cancelar, desfazer o cancelamento | posse (Owner) | ✅ | — | — | — | exceção autorizada, com motivo | — |
| pedir exclusão da agência | posse (Owner) | ✅ | — | — | — | pelo fluxo de exclusão, com motivo e confirmação | — |
| confirmar pagamento ou falha | — | — | — | — | — | — | ✅ evento autenticado e conferido |
| suspender ou reativar administrativamente | comando interno | — | — | — | — | ✅ com motivo | — |
| isentar e tirar a isenção | comando interno | — | — | — | — | ✅ com motivo | — |
| criar agência própria | conta com e-mail confirmado | qualquer conta; o teste só com direito, concedido de forma atômica | | | | ✅ sem teste | — |

> As ações do Owner seguem o caminho do dono, não uma permissão: não se delegam, e nenhum papel personalizado futuro as recebe (decisão de 2026-09-24). A operação nunca simula o consentimento do Owner. Visibilidade de botão é UX; a autorização é conferida no backend em toda operação.

## 3. Entidades e campos

### Plano (contrato versionado no repositório)

| campo | Teste grátis | Essencial | Profissional | Agência |
|---|---|---|---|---|
| preço mensal | R$ 0, 14 dias | R$ 99 | R$ 249 | R$ 499 |
| clientes | 3 | 10 | 30 | 60 |
| equipe | 3 | 5 | 15 | 30 |
| mídia | 5 GB | 50 GB | 200 GB | 1 TB |
| no limite (MVP) | recusa | recusa | recusa | recusa |
| no limite (com adicionais, fora do MVP) | recusa | recusa | adicional | adicional |
| cliente extra (fora do MVP) | — | — | R$ 9,90 | R$ 7,90 |
| pessoa extra (fora do MVP) | — | — | R$ 14,90 | R$ 9,90 |
| +100 GB (fora do MVP) | — | — | R$ 19,90 | R$ 14,90 |

Os preços e limites são os aprovados na decisão de planos. As linhas "fora do MVP" estão decididas, mas não fazem parte do contrato implementável do MVP: no MVP, todo plano recusa no limite, e quem precisa sobe de plano. Fonte única para a landing e para o app; o backend é a autoridade sobre o preço e o limite aplicados. Os números são de lançamento e se revisam sem mudar o modelo.

### Plano selecionado, assinatura e estado comercial

Três coisas distintas, que nunca se confundem:
- **plano selecionado:** o que a agência pretende contratar. Escolher plano ou abrir o checkout não muda o estado comercial;
- **assinatura no provedor:** a recorrência criada no Asaas, quando existe. Uma agência em teste não tem;
- **estado comercial:** a situação efetiva da agência, mudada só pelas transições da seção 4.

### Estado comercial da agência

| campo | regra |
|---|---|
| estado comercial | `teste`, `paga`, `em_atraso`, `cancelando`, `isenta`, `suspensa`, `excluida` |
| plano | o plano vigente; ausente só em `isenta` |
| fim do teste | data aplicada pelo backend no 14º dia após a confirmação do e-mail |
| fim do período pago | vem do provedor |
| fim da carência | 7 dias depois da falha de pagamento |
| motivo da suspensão comercial | `teste_expirado`, `inadimplencia`, `cancelamento` |
| data prevista de exclusão | 90 dias depois da suspensão comercial, pausada durante suspensão administrativa |
| motivo da isenção | obrigatório; nenhuma agência é isenta sem ele |

### Suspensão administrativa

| campo | regra |
|---|---|
| motivo | obrigatório (operação, ordem judicial, segurança) |
| quem e quando | o operador e o instante, auditados |

Independente do estado comercial, e prevalece sobre ele.

### Cadastro pendente

| campo | regra |
|---|---|
| nome da pessoa, e-mail, senha, nome da agência | obrigatórios |
| HMAC do CPF | o CPF em claro nunca é gravado |
| aceite de Termos e Privacidade | a versão aceita, com data e hora |
| expira em | 7 dias após a criação |

Confirmado no prazo, nasce a agência em `teste`. Expirado, o backend o apaga e libera a **reserva temporária** do e-mail e do CPF, que só existe enquanto o cadastro está pendente e nenhum teste foi concedido. Essa limpeza nunca toca a elegibilidade histórica abaixo.

### Elegibilidade ao teste

| campo | regra |
|---|---|
| HMAC do CPF | um teste por CPF |
| conta | um teste por conta |

É a **elegibilidade histórica**: o registro de que aquela conta ou aquele CPF já recebeu um teste. Nasce quando o teste é concedido e nunca é apagado pela limpeza de cadastro pendente nem pela exclusão da agência. O HMAC usa chave fora do banco, com rotação que preserva as chaves anteriores.

### Assinatura e evento do provedor

| campo | regra |
|---|---|
| associação | agência, assinatura, plano e identificador do provedor, gravados pelo backend quando ele cria a cobrança; nunca vindos do navegador nem de campo arbitrário do evento |
| referência da assinatura no provedor | no máximo uma recorrência vigente por agência |
| evento do provedor | guardado com o identificador do provedor, para idempotência e ordem cronológica |
| adicional | tipo, quantidade, preço recorrente, confirmado pelo Owner (fora do MVP) |

**Pertence a:** tudo é da agência, exceto o cadastro pendente (antes da agência) e a elegibilidade (sobrevive a ela).
**Relações:** agência 1—1 estado comercial; agência 1—0..1 assinatura; assinatura 1—N eventos; agência 0..1 suspensão administrativa vigente.

## 4. Estados e transições

```
(cadastro pendente) → teste        # e-mail confirmado em até 7 dias; direito ao teste concedido de forma atômica
(cadastro pendente) → paga         # CPF ou conta já usou o teste: cadastro segue direto para escolher plano pago
teste       → paga                 # primeiro pagamento confirmado por evento verificado do provedor
teste       → suspensa             # 14º dia, pelo backend (motivo teste_expirado)
paga        → em_atraso            # evento verificado de falha de pagamento
paga        → cancelando           # Owner cancela; acesso até o fim do período pago
em_atraso   → paga                 # evento verificado de pagamento
em_atraso   → suspensa             # 8º dia, pelo backend (motivo inadimplencia)
cancelando  → paga                 # Owner desfaz antes da data
cancelando  → suspensa             # fim do período pago, pelo backend (motivo cancelamento)
suspensa    → paga                 # antes da exclusão, e só pelo caminho do motivo:
                                   #   inadimplencia: evento verificado de pagamento da cobrança vigente da assinatura
                                   #   teste_expirado: nova contratação (escolher plano + checkout + primeiro pagamento confirmado)
                                   #   cancelamento: nova contratação; pagar cobrança antiga da assinatura cancelada não reativa
suspensa    → excluida             # data prevista de exclusão vencida, com avisos aos 60, 83 e 89 dias; ou pedido do Owner
(qualquer)  → isenta               # só comando da operação, com motivo
isenta      → (plano pago)         # só comando da operação, com motivo
```

Suspensão administrativa (por cima de qualquer estado):

```
sem → com     # comando da operação, com motivo; bloqueia o acesso
com → sem     # comando da operação; o acesso é recalculado pelo estado comercial
```

**Acesso** = sem suspensão administrativa **e** estado comercial em `teste`, `paga`, `em_atraso`, `cancelando` ou `isenta`. O `status` (`active`/`suspended`) de hoje passa a ser derivado disso — seção 9.

## 5. Regras invioláveis

Cada uma vira teste de integração que fica vermelho sem ela, com casos de sucesso, falha, repetição de evento e concorrência real (duas transações simultâneas, nunca sequenciais).

1. Nenhuma agência acessa sem um estado comercial que permita; a suspensão administrativa sempre bloqueia. Carência e isenção têm acesso explícito.
2. O estado comercial só muda por evento verificado do provedor, prazo aplicado pelo backend, ação autorizada do Owner ou comando operacional permitido. O navegador nunca define estado, pagamento confirmado ou isenção.
3. O mesmo evento do provedor, ou a mesma operação concluída, nunca produz efeito duplicado.
4. Uma conta e um CPF abrem no máximo um teste grátis, de forma atômica sob cadastros simultâneos, sem gravar o CPF em claro.
5. Toda criação de cliente, reativação de cliente ou convite confere o limite no banco (clientes ativos; na equipe, membros ativos mais convites pendentes, contando o Owner: o teste admite o Owner e mais duas pessoas) (o upload segue a cota de mídia atual até a precedência da seção 10 ser decidida), no momento da operação; duas ações simultâneas nunca usam a mesma vaga. No MVP, todo plano recusa o excesso. Quando os adicionais entrarem, a partir do Profissional o excesso só passa com adicional comprado e ativo.
6. Retirar a suspensão administrativa recalcula o acesso pelo estado comercial e nunca o devolve se ele negar.
7. A suspensão administrativa não consome os 90 dias; coexistindo com uma comercial, a contagem pausa e retoma quando ela termina. A exclusão só acontece com o prazo vencido e os avisos enfileirados; a falha de entrega de um e-mail fica registrada e nunca bloqueia nem adia a exclusão.
8. O CPF em claro nunca é gravado em banco, log, erro, telemetria ou auditoria.
9. Só comando operacional autorizado, com motivo e auditoria, isenta ou tira a isenção; agência isenta nunca é cobrada.
10. O portal do cliente nunca expõe plano, situação comercial, cobrança ou adicional; só o Owner age sobre a assinatura; o Admin só lê.
11. O resultado da exclusão é sempre o mesmo, qualquer que seja o mecanismo: apaga o tenant inteiro (registros, mídia no armazenamento, convites, links), guarda só as exceções documentadas, é rastreável, repetível sem inconsistência, e só se dá por concluída depois de cada etapa verificada. No MVP o mecanismo é o comando da operação; o teste prova o resultado do comando.
12. Trocar para um plano menor só é aceito se o uso couber, nunca arquiva, apaga ou esconde nada, e é conferido de novo quando passa a valer.
13. Evento de pagamento fora de ordem nunca desfaz uma transição mais recente. Um evento só muda estado se for autenticado, casar com a associação gravada (agência, assinatura, plano, identificador do provedor) e a transição for permitida a partir do estado e do motivo atuais: pagar cobrança antiga de uma assinatura cancelada não reativa a agência.
14. Adicional só é comprado ou removido com confirmação do Owner, vendo o preço recorrente; entra inteiro na próxima fatura; removido antes da renovação, não é cobrado no ciclo seguinte.
15. Ação operacional privilegiada exige autorização, motivo e auditoria.
16. O `status` da agência nunca é escrito por outro caminho que não a função que o recalcula.
17. Nenhuma resposta do cadastro (corpo, código, tempo) revela se um e-mail tem conta ou se um CPF já usou o teste.
18. Agência em suspensão comercial (sem suspensão administrativa) deixa o Owner ver a Assinatura e abrir o checkout para pagar, e nada mais: nenhuma outra rota, tela ou dado da agência fica acessível. Com suspensão administrativa, nem isso.

## 6. Backend

### Rotas

| método | rota | permissão | devolve |
|---|---|---|---|
| POST | `/signup` | pública, Turnstile, limite por IP e e-mail | sempre a mesma resposta ("enviamos um e-mail para continuar") |
| POST | `/signup/resend` | pública, Turnstile, limite por IP e e-mail | sempre a mesma resposta |
| POST | `/signup/:token/confirm` | pública | agência criada em `teste` (ou direto para escolher plano, sem teste); token expirado orienta a recomeçar |
| POST | `/agencies` | sessão com e-mail confirmado ("Criar minha agência") | a agência nova; teste só com direito |
| GET | `/agencies/:agencyId/subscription` | `assinatura.visualizar` ou posse | plano, estado comercial, uso × limite, próxima fatura, histórico |
| POST | `/agencies/:agencyId/subscription/checkout` | posse | URL do checkout hospedado do Asaas para o plano escolhido |
| POST | `/agencies/:agencyId/subscription/cancel` | posse | estado `cancelando` com a data |
| POST | `/agencies/:agencyId/subscription/resume` | posse | volta para `paga`, se antes da data |

Cancelar pede ao Asaas o fim da recorrência; a agência fica `cancelando` só quando o provedor confirma, mantém o acesso até o fim do período pago e não recebe cobrança depois dessa data. Se o pedido ao provedor falhar, a falha fica registrada, nada aparece como cancelado, e a operação pode ser repetida (idempotente). Desfazer o cancelamento antes da data também depende da confirmação do provedor de que a recorrência continua.

Ações de plano na interface do MVP: escolher plano e pagar (a partir do teste ou da suspensão comercial), cancelar e desfazer o cancelamento. Trocar para um plano menor é pelo suporte. Subir de plano: em aberto (seção 10).

A consulta da assinatura e o checkout continuam disponíveis ao Owner de uma agência em suspensão comercial, por um caminho próprio que não reabre o acesso ao tenant (regra 18); o resto segue o `status` suspenso.
| POST | `/billing/webhooks/asaas` | pública, assinatura do provedor verificada | 200 idempotente |

Fora do MVP: rotas de adicional, troca agendada de plano e pedido de exclusão pelo Owner.

O cadastro reabre o cadastro público no Better Auth (substitui o `disableSignUp: true` de `apps/api/src/modules/auth/better-auth.ts`) e reaproveita o limitador de `auth-limiter.ts`, com o Turnstile e os limites de envio e reenvio da confirmação integrados a ele. Login, convite, redefinição e troca de senha continuam como estão.

A recusa por limite é um código de erro próprio, traduzido na mensagem de limite. Os erros do banco seguem o mapeamento de sempre (A00xx, 42501, 40P01 → nunca 500).

### Persistência

- **Tabelas novas:** cadastro pendente, elegibilidade ao teste (HMAC), assinatura, eventos do provedor, suspensão administrativa, e as colunas do estado comercial (na própria `agencies` ou numa tabela 1—1; a forma é da implementação, a migration é estrutural de qualquer jeito).
- **Funções `security definer` de escopo único e auditadas:** aplicar evento verificado do provedor; aplicar os prazos (fim do teste, fim da carência, fim do período cancelado, data de exclusão); recalcular o `status`; conferir e reservar o limite do plano, com trava na agência, na mesma transação da inserção.
- **Gatilho** que recusa escrita direta no `status`.

### RLS

- Assinatura, eventos do provedor e estado comercial: leitura pela agência só com `assinatura.visualizar` ou posse; escrita só pelas funções acima, nunca por `ageniza_app` direto.
- Cadastro pendente e elegibilidade: nenhum acesso por `ageniza_app`; só pelas funções do cadastro.
- Nenhuma tabela desta SPEC é visível pelo vínculo de cliente (portal).

## 7. Frontend

### Telas

| # | tela | rota | o que mostra | quem acessa |
|---|---|---|---|---|
| 1 | Landing e planos | site estático (`ageniza.com.br`) | produto, funcionalidades, tabela de planos do contrato, CTA para o cadastro | visitante |
| 2 | Cadastro | `/cadastro` | nome, e-mail, senha, nome da agência, CPF, aceite de Termos e Privacidade | visitante |
| 3 | Confirme seu e-mail / confirmação | `/cadastro/confirmar/:token` | instrução, reenvio, sucesso, link expirado | quem se cadastrou |
| 4 | Criar minha agência | dentro do app, a partir do seletor de contexto | nome da agência; teste só com direito | conta com e-mail confirmado |
| 5 | Banner do teste e do atraso | área da agência | dias restantes ou atraso; CTA só para o Owner | membros |
| 6 | Escolher plano → checkout → retorno | `/agencia/:agenciaId/assinatura/planos` | planos do contrato; retorno mostra "processando pagamento" até o evento verificado | Owner |
| 7 | Assinatura | `/agencia/:agenciaId/assinatura` | plano, uso × limite, próxima fatura, histórico, trocar de plano, cancelar | Owner age, Admin lê |
| 8 | Limite atingido | em cada ação (cliente, convite, upload) | recurso, limite, próxima ação possível | todo membro |
| 9 | Agência suspensa | no seletor de contexto e ao entrar | motivo compreensível, data prevista de exclusão quando houver, "Pagar" para o Owner | membros |
| 10 | Pedir exclusão (fora do MVP) | dentro da Assinatura | efeitos, confirmação explícita | Owner |

### Esboço

```
Cadastro                                   Assinatura (Owner)
┌───────────────────────────────┐          ┌───────────────────────────────────────┐
│ Crie sua agência              │          │ Plano Essencial · próxima fatura 01/11 │
│ Nome · E-mail · Senha         │          │ Clientes  7/10  ▓▓▓▓▓▓▓░░░            │
│ Nome da agência · CPF         │          │ Equipe    3/5   ▓▓▓▓▓▓░░░░            │
│ [ ] Termos e Privacidade      │          │ Mídia    12/50 GB ▓▓░░░░░░░           │
│ [Turnstile]                   │          │ [Trocar de plano]  [Cancelar]          │
│ [Começar teste grátis]        │          │ Histórico de cobrança                  │
└───────────────────────────────┘          └───────────────────────────────────────┘

Banner (teste)                              Limite atingido
┌───────────────────────────────────────┐  ┌───────────────────────────────────────┐
│ Faltam 5 dias do teste grátis  [Escolher plano] │ Seu plano permite 10 clientes.  │
└───────────────────────────────────────┘  │ Owner: [Ver planos] · demais: fale com │
                                           │ o dono da agência                      │
                                           └───────────────────────────────────────┘
```

### Variação por papel

- **Owner:** vê e age na Assinatura; o banner e a mensagem de limite levam à contratação.
- **Admin:** vê a Assinatura só em leitura, sem botões de ação; o banner informa sem CTA.
- **Demais papéis:** não veem a Assinatura; o limite diz "fale com o dono da agência".
- **Portal do cliente:** nada comercial aparece.

### Estados da tela

- **Cadastro:** erro de validação por campo; e-mail ou CPF já usados nunca diferenciados (regra 17).
- **Confirmação:** link expirado orienta a recomeçar; reenvio com resposta genérica.
- **Retorno do checkout:** pendente, confirmado, falho e "voltou sem confirmação"; só o evento verificado muda o estado.
- **Assinatura:** carregando; histórico vazio; erro do provedor com tentar de novo; sem permissão espelha o 404 do backend.
- **Agência suspensa:** a mensagem não revela detalhe operacional da suspensão administrativa.

## 8. Infraestrutura

- **Jobs no worker:** aplicar prazos (fim do teste, fim da carência, fim do período cancelado), avisos do teste (7º, 12º e 14º dia) e de exclusão (60, 83 e 89 dias), limpeza de cadastro pendente expirado. Todos idempotentes, pelo dia de São Paulo, por função `security definer` de escopo único, e recuperam a execução perdida (um prazo vencido enquanto o worker estava parado é aplicado na rodada seguinte). Cada aviso guarda tentativas e falhas de entrega, para auditoria.
- **E-mail:** confirmação do cadastro, "você já tem conta", avisos do teste, falha de pagamento, avisos de exclusão — pela fila de notificação existente.
- **Provedor de pagamento:** Asaas (checkout hospedado, assinatura recorrente, webhook autenticado).
- **Segredos novos:** chave do HMAC do CPF (fora do banco, com rotação), credenciais e segredo de webhook do Asaas, chave do Turnstile.
- **App novo:** landing estática, consumindo o contrato de planos de `packages/contracts`.
- **Exclusão:** no MVP, comando da operação com conferência; o runbook de backup ganha prazo de expurgo documentado.

## 9. Impacto estrutural

- [x] **altera tabela que já existe** — `agencies` ganha estado comercial (ou uma tabela 1—1) e o `status` passa a ser derivado. Decisão estrutural registrada.
- [ ] muda formato de resposta que outras rotas copiam
- [x] **mexe em RLS e funções de mais de um módulo** — o limite do plano entra nas funções de criar e reativar cliente (Clientes), criar convite (Colaboradores e Clientes) e, depois da decisão de precedência da seção 10, reservar upload (Mídia). Decisão estrutural registrada.
- [x] **muda como a autorização é avaliada** — o acesso de tenant passa a vir de estado comercial + suspensão administrativa, contido numa função que mantém o `status`; os 88 pontos que leem o `status` não mudam.
- [x] **exigiria backfill** — agências existentes: a nossa como Isenta com motivo, as de teste e demonstração como Isentas "anterior à cobrança", revistas pela operação.
- Além da lista: o **cadastro público** reabre a SPEC de auth (`disableSignUp`), e a **exclusão física do tenant** usa a exceção "fluxo de retenção" da decisão "Exclusão reversível".

## 10. Em aberto

| ponto | gatilho | quem decide |
|---|---|---|
| Login com Google | a taxa de abandono no cadastro do teste justificar | Pedro Vidal |
| Emissão de nota fiscal | a primeira agência pagante | Pedro Vidal + contador |
| Ciclo anual | o primeiro pedido de agência pagante | Pedro Vidal |
| Cupom, desconto, moeda estrangeira, reembolso pelo produto, troca de dono | o primeiro pedido real de cada um | Pedro Vidal |
| Tirar o limite da equipe | a equipe aparecer como motivo de recusa na conversão | Pedro Vidal |
| Painel de operação | a operação agir várias vezes por semana, ou os erros manuais justificarem | Pedro Vidal |
| Construtor visual ou CMS da landing | marketing precisar publicar sem desenvolvimento com frequência | Pedro Vidal |
| Adicionais (Profissional e Agência) — decididos, fora do MVP | a primeira agência estourar o plano Agência | Pedro Vidal |
| Troca para plano menor agendada no próximo ciclo — decidida, fora do MVP (no MVP, pelo suporte) | o suporte receber pedidos de troca com frequência | Pedro Vidal |
| Exclusão automática em 90 dias — decidida, fora do MVP (no MVP, comando da operação) | a exclusão manual virar rotina | Pedro Vidal |
| Tabela de retenção fiscal por tipo de registro | antes da primeira cobrança real | contador ou assessoria jurídica |
| Precedência entre o limite de mídia do plano e a cota individual (`agency_storage_quotas`, em bytes e em quantidade de objetos, com o padrão do deploy). Não se assume que um substitui o outro. **Impacto:** a regra de upload de toda agência. Até a decisão, a mídia mantém o comportamento atual, e nenhuma task de limite o altera por tabela; a task de limite de mídia identifica a migração necessária sem inferir regra comercial | antes da task de limite de mídia | Pedro Vidal |
| Como se sobe de plano no MVP: pelo suporte, ou na interface com um ciclo novo a partir do pagamento, sem proporcional | antes da task de assinatura | Pedro Vidal |
| Se a conta (usuário) nasce no cadastro, não confirmada, ou só na confirmação junto com a agência | antes da task de cadastro | Pedro Vidal |

## 11. Decisões registradas

Reabertas por esta SPEC:
- [Entrada de agências apenas por comando interno](../docs/business/decisions/2026-09-15-entrada-de-agencias-apenas-por-comando-interno.md) (2026-09-15) — substituída na parte do cadastro público
- [Cobrança existe no plano do produto, não no sistema, e tem gatilho](../docs/business/decisions/2026-09-24-cobranca-existe-no-plano-do-produto-nao-no-sistema-e-tem.md) (2026-09-24) — gatilho atingido

Desta entrevista (2026-10-13):
- [Agência entra por cadastro público, com teste grátis](../docs/business/decisions/2026-10-13-agencia-entra-por-cadastro-publico-com-teste-gratis.md)
- [Teste grátis dura 14 dias, com limites de entrada](../docs/business/decisions/2026-10-13-teste-gratis-dura-14-dias-com-limites-de-entrada.md)
- [Agência suspensa por falta de pagamento é apagada em 90 dias, com aviso](../docs/business/decisions/2026-10-13-agencia-suspensa-por-falta-de-pagamento-e-apagada-em-90-dias.md)
- [Login no lançamento é só e-mail e senha](../docs/business/decisions/2026-10-13-login-no-lancamento-e-so-email-e-senha.md)
- [Agência paga dentro do produto, por checkout hospedado do provedor](../docs/business/decisions/2026-10-13-agencia-paga-no-produto-por-checkout-do-provedor.md)
- [O que fica fora do lançamento da cobrança](../docs/business/decisions/2026-10-13-fora-do-lancamento-da-cobranca.md)
- [Um teste grátis por conta e por documento](../docs/business/decisions/2026-10-13-um-teste-gratis-por-conta-e-por-documento.md)
- [Assinatura pode começar a qualquer momento, e pagamento que falha tem 7 dias de carência](../docs/business/decisions/2026-10-13-assinatura-paga-a-qualquer-momento-e-falha-tem-7-dias.md)
- [Só o Owner cuida da assinatura](../docs/business/decisions/2026-10-13-so-o-owner-cuida-da-assinatura.md)
- [Adicional vale na hora e entra inteiro na próxima fatura](../docs/business/decisions/2026-10-13-adicional-vale-na-hora-e-entra-na-proxima-fatura.md)
- [O que conta no limite do plano](../docs/business/decisions/2026-10-13-o-que-conta-no-limite-do-plano.md)
- [Trocar para plano menor exige caber no plano novo e vale no próximo ciclo](../docs/business/decisions/2026-10-13-trocar-para-plano-menor-exige-caber-e-vale-no-proximo-ciclo.md)
- [Cancelar mantém o acesso até o fim do período pago](../docs/business/decisions/2026-10-13-cancelar-mantem-o-acesso-ate-o-fim-do-periodo-pago.md)
- [Isenção é estado próprio, e só por decisão expressa](../docs/business/decisions/2026-10-13-isencao-e-estado-proprio-e-so-por-decisao-expressa.md)
- [Planos e preços de lançamento](../docs/business/decisions/2026-10-13-planos-e-precos-de-lancamento.md)
- [Cadastro pede o mínimo, e o teste começa na confirmação do e-mail](../docs/business/decisions/2026-10-13-cadastro-pede-o-minimo-e-o-teste-comeca-na-confirmacao-do-email.md)
- [Quem já tem conta cria a própria agência com a mesma conta](../docs/business/decisions/2026-10-13-quem-ja-tem-conta-cria-a-propria-agencia-com-a-mesma-conta.md)
- [O fim do teste é aplicado pelo backend, e os avisos só avisam](../docs/business/decisions/2026-10-13-fim-do-teste-e-aplicado-pelo-backend-e-os-avisos-so-avisam.md)
- [O provedor de pagamento inicial é o Asaas](../docs/business/decisions/2026-10-13-o-provedor-de-pagamento-inicial-e-o-asaas.md)
- [Estado comercial da agência separado do acesso e da suspensão administrativa](../docs/business/decisions/2026-10-13-estado-comercial-da-agencia-separado-do-acesso.md)
- [O que sobra de uma agência excluída](../docs/business/decisions/2026-10-13-o-que-sobra-de-uma-agencia-excluida.md)
- [O CPF do cadastro só é guardado como HMAC](../docs/business/decisions/2026-10-13-o-cpf-do-cadastro-so-e-guardado-como-hmac.md)
- [Quem vê e quem age sobre o plano](../docs/business/decisions/2026-10-13-quem-ve-e-quem-age-sobre-o-plano.md)
- [A operação age por comando interno auditado](../docs/business/decisions/2026-10-13-operacao-age-por-comando-interno-auditado.md)
- [Landing estática, separada do app, e planos num contrato único](../docs/business/decisions/2026-10-13-landing-estatica-e-planos-num-contrato-unico.md)
- [Matriz de autorização da assinatura](../docs/business/decisions/2026-10-13-matriz-de-autorizacao-da-assinatura.md)
- [Regras invioláveis da entrada e da cobrança](../docs/business/decisions/2026-10-13-regras-inviolaveis-da-entrada-e-da-cobranca.md)
- [Recorte do MVP da entrada e da cobrança](../docs/business/decisions/2026-10-13-recorte-do-mvp-da-entrada-e-da-cobranca.md)
- [Estrutural: o status da agência passa a ser derivado do estado comercial e da suspensão administrativa](../docs/business/decisions/2026-10-13-estrutural-o-status-da-agencia-passa-a-ser-derivado.md)
- [Estrutural: o limite do plano é conferido no banco, com trava](../docs/business/decisions/2026-10-13-estrutural-o-limite-do-plano-e-conferido-no-banco.md)
- [Cadastro público protegido contra robô e sem enumeração de conta](../docs/business/decisions/2026-10-13-cadastro-publico-protegido-contra-robo-e-sem-enumeracao.md)

## 12. Recorte de implementação

**Ainda não gerado:** a implementação espera a validação do MVP com agências reais (gatilho na [decisão](../docs/business/decisions/2026-10-13-a-entrada-self-service-espera-a-validacao-do-mvp.md)).

Quando gerado, só o que está dentro do [recorte do MVP](../docs/business/decisions/2026-10-13-recorte-do-mvp-da-entrada-e-da-cobranca.md). As issues são geradas por `/modulo-issues entrada`.

**Histories (MVP):** cadastro público com teste grátis · limites do plano · pagar a assinatura · ciclo comercial aplicado pelo backend · operação por comando · landing e contrato de planos.

Os pontos da seção 10 marcados "antes da task" bloqueiam só a task correspondente, não a SPEC: conta no cadastro ou na confirmação (task de cadastro), subir de plano (task de assinatura), limite de mídia × `agency_storage_quotas` (task de limite de mídia).
