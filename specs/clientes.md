# Clientes

| | |
|---|---|
| **Status** | aprovado |
| **Submódulos** | carteira de clientes · detalhe do cliente · estudo de marca e conversa · acessos ao portal · portal do cliente (casca) · encerramento de contrato |
| **Sessões** | 2026-09-26 |
| **Decidido por** | Pedro Vidal, em sessão |

> **Hoje não existe como criar um cliente pelo produto.** `clients` tem só `name` e `status`, e só policy de `SELECT` — nenhuma rota, nenhuma policy de escrita. A rota de convidar pessoa para o portal (`POST /agencies/:agencyId/clients/:clientId/invitations`) já existe e depende de um cliente que ninguém consegue criar.
>
> **`ClientAssignment` não existe.** Decisões anteriores e `colaboradores.md` o citavam como a ligação entre colaborador e cliente; ele nunca foi criado em migration. Nada neste módulo o cria — atribuição nasce em Conteúdo e Tarefas.
>
> Herda de [`autorizacao.md`](autorizacao.md): o contrato de listagem, `archived`/`removed`, "sem permissão" não é tela, os três tratamentos de carregamento e a invalidação de query depois de cada escrita. E de [`colaboradores.md`](colaboradores.md): o armazenamento de identidade (#100) e o desenho da seção de convites.

## 1. Propósito

Dar à agência a carteira dos seus clientes — cadastrar, acompanhar, encerrar — e dar ao cliente a porta de entrada do portal. É o primeiro módulo com **duas frentes de tela e dois públicos**: o colaborador que tria a carteira e o dono do negócio que entra para conferir e aprovar.

Entrega **o cliente e a casca**: cadastro, estudo de marca com conversa em thread, acessos ao portal, encerramento de contrato, e o esqueleto das áreas que os próximos módulos preenchem.

### Não resolve

- **Calendário editorial, conteúdo, aprovação e comentário de post.** Módulo Conteúdo. O que o bloco 0 desta entrevista levantou para ele está registrado em `decisions.md` como bloco 0 já colhido daquela entrevista.
- **Pastas de mídia e mídia visível ao cliente.** Conteúdo — é a estrutural pendente da seção 9.
- **Tarefas, responsável e atribuição de colaborador a cliente.** Tarefas e Conteúdo.
- **Indicadores de pendente, em revisão e atrasado.** Dependem de Conteúdo e Tarefas; o card reserva o espaço.
- **Relatório.** O de dado interno é decidido quando Conteúdo e Tarefas existirem; o de métrica externa (Meta) está fora do MVP — seção 10.
- **Notificação** por e-mail ou push — seção 10.
- **Valor de contrato, início, forma de pagamento.** Financeiro.
- **Papel dentro do portal.** Todas as pessoas de um cliente têm o mesmo acesso.
- **Thread interna** da agência sobre o cliente. Não existe — seção 5.
- **Histórico de versões do estudo de marca.** Só quem alterou por último e quando.

## 2. Atores e autorização

| capacidade | permissão | Admin | Gestor de conta | Produção | Vendas | Financeiro |
|---|---|:-:|:-:|:-:|:-:|:-:|
| Ver listagem, detalhe, estudo de marca e threads | `cliente.visualizar` | ✅ | ✅ | ✅ | ✅ | ✅ |
| Editar cadastro e foto, editar estudo e personas, abrir, responder e resolver thread | `cliente.operar` | ✅ | ✅ | — | — | — |
| Cadastrar cliente novo | `cliente.cadastrar` | ✅ | ✅ | — | — | — |
| Agendar ou desmarcar encerramento, arquivar e reativar | `cliente.arquivar` | ✅ | — | — | — | — |
| Ver acessos e convidar pessoa para o portal | `cliente.convidar_usuario` ¹ | ✅ | — | — | — | — |
| Reenviar convite de portal | `convite.reenviar` ¹ | ✅ | — | — | — | — |
| Cancelar convite de portal | `convite.cancelar` ¹ | ✅ | — | — | — | — |
| Remover e reativar pessoa do portal | `cliente.remover_usuario` | ✅ | — | — | — | — |

¹ já existe no catálogo e já é concedida ao `admin`. `convite.reenviar` e `convite.cancelar` valem para convite de colaborador **e** de cliente — por isso nenhum outro preset recebe gestão de portal (seção 10).

**Todo colaborador vê todos os clientes.** Não há restrição por atribuição.

**Cadastrar é administrativo**, separado de `operar`: cliente novo é compromisso comercial, e a cobrança prevista é por número de clientes. Produção lê o estudo para trabalhar, mas não o edita nem responde o cliente. Vendas não cadastra: quem cadastra é quem vai atender.

### A pessoa do portal

Não tem papel nem permissão do catálogo: é autorizada pelo **vínculo ativo** em `client_memberships`, por `requireClientAccess`. Todas as pessoas de um cliente podem o mesmo: ler o cadastro do próprio cliente, ler o estudo de marca e as personas ativas, abrir thread e comentar. **Nunca** edita o estudo e **nunca** resolve thread.

Colaborador da agência — Owner incluído — não entra no portal sem vínculo de cliente próprio.

## 3. Entidades e campos

### Cliente — `clients` (colunas novas)

| campo | tipo | obrigatório | regra |
|---|---|:-:|---|
| `name` | texto | ✅ | *já existe*. Único entre os **ativos** da agência, sem diferenciar maiúsculas |
| `photo_key` | texto | — | objeto no armazenamento de identidade |
| `legal_name` | texto | — | razão social |
| `tax_id` | texto | — | CNPJ **ou** CPF, só dígitos, 14 ou 11. **Não é único** |
| `segment` | texto | — | segmento, livre |
| `website` | texto | — | URL `http(s)` |
| `instagram_handle` | texto | — | sem `@`, no formato aceito pelo Instagram. O simulador de feed de Conteúdo lê daqui |
| `contact_name` | texto | — | contato do dono |
| `contact_phone` | texto | — | telefone/WhatsApp |
| `contact_email` | texto | — | e-mail de contato. **Não** é o e-mail de acesso ao portal |
| `closing_date` | data | — | último dia do contrato; ver seção 4 |
| `archived_at` | timestamp | — | preenchido ao arquivar, limpo ao reativar |
| `updated_by` | usuário | — | quem alterou o cadastro por último |

**Pertence a:** agência. **Relações:** 0..N vínculos de portal, 0..N convites de portal, 1 estudo de marca (sete seções), 0..N personas, 0..N threads.

Dados do cliente e acesso ao portal são **independentes**: o contato é cadastro, preenchido pela agência; o acesso é convite para um e-mail, que pode ou não ser o do contato. O contato nunca é derivado da conta de quem aceitou.

**Nenhum campo interno da agência sobre o cliente** — nota, avaliação, risco — mora em `clients`, porque o portal lê a linha inteira (seção 5, regra 10).

### Seção do estudo de marca — `client_brand_sections`

Sete seções **fixas, definidas pelo produto**. Uma linha por seção preenchida.

| `section_key` | conteúdo |
|---|---|
| `branding` | texto livre |
| `tone_of_voice` | texto livre |
| `colors` | lista de `{ nome, código hexadecimal }` |
| `positioning` | texto livre |
| `archetype` | um dos doze: Inocente, Sábio, Explorador, Fora-da-lei, Mago, Herói, Amante, Bobo da corte, Cara comum, Cuidador, Governante, Criador |
| `personas` | a seção agrupa as personas (tabela abaixo); não tem texto próprio |
| `observations` | texto livre |

Cada linha guarda `updated_by` e `updated_at`. **Preenchimento** do estudo é derivado: seções com conteúdo sobre sete, contando `personas` como preenchida quando há ao menos uma persona ativa.

### Persona — `client_personas`

| campo | tipo | obrigatório | regra |
|---|---|:-:|---|
| `name` | texto | ✅ | |
| `description` · `pains` · `desires` · `objections` | texto | — | livres |
| `status` | `active` \| `archived` | ✅ | entidade: arquiva, não exclui |

**Pertence a:** cliente. Várias por cliente.

### Thread — `client_threads`

| campo | tipo | obrigatório | regra |
|---|---|:-:|---|
| `client_id` | cliente | ✅ | sempre preenchido; é por ele que a RLS isola |
| `section_key` | seção | um dos dois | assunto: uma seção do estudo… |
| `persona_id` | persona | um dos dois | …ou uma persona. **Exatamente um** |
| `opened_by` · `opened_side` | usuário · `agency` \| `client` | ✅ | lado definido pelo servidor, nunca pelo corpo |
| `resolved_at` · `resolved_by` | timestamp · usuário | — | preenchidos por quem resolve |

Conteúdo **acrescentará** `content_id` como terceiro assunto possível — decidido e registrado como estrutural.

### Comentário — `client_thread_comments`

| campo | tipo | obrigatório | regra |
|---|---|:-:|---|
| `thread_id` · `client_id` | thread · cliente | ✅ | `client_id` repetido para a RLS não precisar de join |
| `author_user_id` · `author_side` | usuário · `agency` \| `client` | ✅ | lado definido pelo servidor |
| `body` | texto | ✅ | não vazio, até 5.000 caracteres |

**Imutável**: sem edição e sem exclusão, nem pelo autor.

## 4. Estados e transições

### Cliente

```
(novo)                 → active                  # cliente.cadastrar; só o nome
active                 → active + closing_date   # cliente.arquivar; data >= hoje
active + closing_date  → active                  # cliente.arquivar; desmarcar antes da data
active (+ closing_date)→ archived                # cliente.arquivar, na hora — ou o job, no dia seguinte à closing_date
archived               → active                  # cliente.arquivar; recusado se o nome estiver em uso entre os ativos
```

**Encerramento agendado** não é estado próprio: é `active` com `closing_date`. Até o fim da data tudo funciona — **inclusive o portal**. "Encerra em N dias" é derivado, nunca persistido. A data é interpretada no fuso `America/Sao_Paulo` (seção 10).

**Arquivar**, pelo caminho que for, tem sempre o mesmo efeito, porque os dois chamam a mesma função (seção 6):

- o portal fica inacessível na requisição seguinte — `requireClientAccess` já devolve 404;
- os **convites de portal pendentes são revogados**;
- os **vínculos são preservados**, então reativar devolve o acesso a quem tinha;
- `closing_date` é limpa e `archived_at` preenchido;
- um evento é gravado em `audit.events`.

Não há pré-condição: arquiva-se com thread aberta, persona ou o que houver. **Cliente arquivado é somente leitura** — a única ação é reativar.

### Pessoa do portal — `client_memberships`

```
(convite aceito) → active    # fluxo de convite que já existe
active           → removed   # cliente.remover_usuario; perde o acesso e todas as sessões, na requisição seguinte
removed          → active    # cliente.remover_usuario; reativação direta, sem convite
```

Um convite novo aceito por alguém `removed` também reativa o mesmo vínculo — `accept_invitation` já faz isso.

### Thread

O estado é **derivado**, não persistido:

- **resolvida** quando `resolved_at` existe e é posterior ao último comentário;
- **aberta** em qualquer outro caso.

Por isso **comentário novo reabre**, de qualquer lado, sem ninguém precisar alterar a thread — e o cliente, que não pode resolver, também não precisa de permissão de escrita nela para reabri-la. Não existe ação de "reabrir".

**Aguardando a agência**: thread aberta cujo último comentário é do lado `client`. **Com resposta da agência**: thread aberta cujo último comentário é do lado `agency`.

### Persona

```
active   → archived   # cliente.operar; some do portal, threads ficam somente leitura
archived → active     # cliente.operar
```

## 5. Regras invioláveis

Garantidas pelo banco — RLS, *grant* ou índice — e não apenas pela rota. Cada uma vira teste de integração contra o banco.

1. Pessoa do portal **não lê** cadastro, seções, personas, threads nem comentários de **outro cliente**, nem da mesma agência.
2. Colaborador sem vínculo de cliente **não** passa em `requireClientAccess`, sendo Admin ou Owner.
3. Pessoa do portal **não escreve** em `clients`, `client_brand_sections` nem `client_personas`.
4. Pessoa do portal **não lê** persona `archived`.
5. `client_thread_comments` **não tem `UPDATE` nem `DELETE`** concedidos a `ageniza_app`.
6. Com o cliente `archived`, **nenhuma escrita** é aceita em `clients` (exceto pela função de reativar), seções, personas, threads, comentários e convites daquele cliente.
7. Dois clientes `active` com o mesmo nome, sem diferenciar maiúsculas, na mesma agência, **violam índice único** — inclusive sob concorrência. Um `archived` com o mesmo nome não viola.
8. Reativar um cliente cujo nome está em uso entre os ativos é **recusado** com erro de conflito; o nome não é alterado.
9. Resolver thread exige `cliente.operar`; vínculo de cliente **nunca** grava `resolved_at`.
10. O lado de um comentário ou thread é `client` **se e somente se** quem escreve tem vínculo ativo com aquele cliente e escreve pela rota do portal; `agency` exige `cliente.operar`. Um colaborador não escreve como cliente, e o cliente não escreve como agência.
11. **Não existe thread interna**: nenhuma coluna ou valor torna uma thread invisível ao cliente dela.
12. `clients.status` só muda pelas funções de arquivar e reativar: `ageniza_app` não tem `UPDATE` na coluna.
13. `client_memberships.status` só muda pela função de remover e reativar: a coluna continua fora do *grant* de `UPDATE` — senão a policy que já existe deixaria a pessoa se reativar sozinha.
14. A função do job **só** arquiva clientes com `closing_date` anterior a hoje; chamada por qualquer um, não tem outro efeito.
15. Arquivar revoga **todos** os convites pendentes daquele cliente, e reativar **não** os restaura.
16. Nome e foto de quem comentou são lidos **através do comentário**; nenhuma rota do portal lê `auth."user"` sem amarrar no comentário daquele cliente — `auth."user"` não tem RLS.
17. `pageSize` nunca passa de 100.

## 6. Backend

### Rotas da agência

Todas sob `requireAgencyAccess`, e o cliente de `:clientId` precisa pertencer a `:agencyId` — senão 404.

| método | rota | permissão | devolve |
|---|---|---|---|
| `GET` | `/agencies/:agencyId/clients` | `cliente.visualizar` | `{ data, meta }` paginado |
| `POST` | `/agencies/:agencyId/clients` | `cliente.cadastrar` | `201` com o cliente; `409` se o nome estiver em uso |
| `GET` | `/agencies/:agencyId/clients/:clientId` | `cliente.visualizar` | cadastro completo mais o resumo da aba Geral |
| `PATCH` | `/agencies/:agencyId/clients/:clientId` | `cliente.operar` | o cliente atualizado; `409` no nome |
| `PUT` | `/agencies/:agencyId/clients/:clientId/photo` | `cliente.operar` | a foto no armazenamento de identidade |
| `DELETE` | `/agencies/:agencyId/clients/:clientId/photo` | `cliente.operar` | `204` |
| `PUT` | `/agencies/:agencyId/clients/:clientId/closing` | `cliente.arquivar` | o cliente com `closingDate` |
| `DELETE` | `/agencies/:agencyId/clients/:clientId/closing` | `cliente.arquivar` | o cliente sem `closingDate` |
| `POST` | `/agencies/:agencyId/clients/:clientId/archive` | `cliente.arquivar` | o cliente `archived` |
| `POST` | `/agencies/:agencyId/clients/:clientId/reactivate` | `cliente.arquivar` | o cliente `active`; `409` no nome |
| `GET` | `/agencies/:agencyId/clients/:clientId/brand-study` | `cliente.visualizar` | as sete seções, as personas e o preenchimento |
| `PUT` | `/agencies/:agencyId/clients/:clientId/brand-study/sections/:sectionKey` | `cliente.operar` | a seção |
| `POST` | `/agencies/:agencyId/clients/:clientId/personas` | `cliente.operar` | `201` com a persona |
| `PATCH` | `/agencies/:agencyId/clients/:clientId/personas/:personaId` | `cliente.operar` | a persona |
| `POST` | `/agencies/:agencyId/clients/:clientId/personas/:personaId/archive` | `cliente.operar` | a persona `archived` |
| `POST` | `/agencies/:agencyId/clients/:clientId/personas/:personaId/unarchive` | `cliente.operar` | a persona `active` |
| `GET` | `/agencies/:agencyId/clients/:clientId/threads` | `cliente.visualizar` | threads de um assunto, paginado |
| `POST` | `/agencies/:agencyId/clients/:clientId/threads` | `cliente.operar` | `201` com a thread e o primeiro comentário |
| `GET` | `/agencies/:agencyId/clients/:clientId/threads/:threadId/comments` | `cliente.visualizar` | comentários, paginado |
| `POST` | `/agencies/:agencyId/clients/:clientId/threads/:threadId/comments` | `cliente.operar` | `201` com o comentário |
| `POST` | `/agencies/:agencyId/clients/:clientId/threads/:threadId/resolve` | `cliente.operar` | a thread resolvida |
| `GET` | `/agencies/:agencyId/clients/:clientId/members` | `cliente.convidar_usuario` | pessoas do portal, paginado |
| `POST` | `/agencies/:agencyId/clients/:clientId/members/:membershipId/remove` | `cliente.remover_usuario` | o vínculo `removed` |
| `POST` | `/agencies/:agencyId/clients/:clientId/members/:membershipId/reactivate` | `cliente.remover_usuario` | o vínculo `active` |
| `GET` | `/agencies/:agencyId/clients/:clientId/invitations` | `cliente.convidar_usuario` | convites de portal pendentes, paginado |

### Rotas do portal

Todas sob `requireSession` e `requireClientAccess` — o mesmo padrão de `POST /clients/:clientId/onboarding/seen`, que já existe.

| método | rota | devolve |
|---|---|---|
| `GET` | `/clients/:clientId` | cadastro do próprio cliente, leitura, e o resumo do Início |
| `GET` | `/clients/:clientId/brand-study` | seções e **personas ativas** |
| `GET` | `/clients/:clientId/threads` | threads de um assunto, paginado |
| `POST` | `/clients/:clientId/threads` | `201`; lado `client` |
| `GET` | `/clients/:clientId/threads/:threadId/comments` | comentários, paginado |
| `POST` | `/clients/:clientId/threads/:threadId/comments` | `201`; lado `client`; recusado em persona arquivada |

### Rotas que já existem

- `POST /agencies/:agencyId/clients/:clientId/invitations` — convidar para o portal. Passa a recusar cliente `archived` também na criação (hoje só o aceite recusa).
- `POST /agencies/:agencyId/invitations/:invitationId/resend` e `DELETE /agencies/:agencyId/invitations/:invitationId` — sem mudança.
- `POST /clients/:clientId/onboarding/seen` — marca o tour como visto. Rever o tour pelo menu não chama nada.

### Listagens

| rota | padrão | ordem | parâmetros nomeados |
|---|---|---|---|
| clientes | **20** | `sort=attention` (padrão): com thread aguardando a agência primeiro, depois nome ascendente · `sort=name:asc` | `search` (nome, razão social, @) · `status=active` (padrão) \| `archived` |
| threads | **20** | última atividade, mais recente primeiro | `sectionKey` **ou** `personaId` (obrigatório, um dos dois) · `state=open` \| `resolved` (sem ele, todas) |
| comentários | **50** | mais antigo primeiro | — |
| pessoas do portal | **20** | nome ascendente | `status=active` (padrão) \| `removed` |
| convites de portal | **20** | expira primeiro | — |

**Item da listagem de clientes:** `id`, `name`, `photoUrl`, `instagramHandle`, `status`, `closingDate`, `threadsAwaitingAgency` e `pendingInvitations`. `pendingInvitations` só vem para quem tem `cliente.convidar_usuario`; para os demais o campo é omitido, não zero.

**Resumo da aba Geral**, no `GET` do detalhe: preenchimento do estudo, threads aguardando a agência, threads com resposta da agência, pessoas ativas no portal.

**Resumo do Início do portal**, no `GET /clients/:clientId`: threads abertas com resposta da agência e preenchimento do estudo.

### Persistência

Duas migrations, porque são duas estruturais diferentes e a segunda depende da primeira. A **primeira** traz colunas, tabelas, permissões e RLS; a **segunda**, as funções `security definer` da tabela mais abaixo.

**Estrutural — altera `clients`** (seção 9):

- as colunas da seção 3, todas anuláveis, sem backfill;
- checagens de formato de `tax_id`, `website` e `instagram_handle`;
- índice único parcial `(agency_id, lower(name)) where status = 'active'`;
- *grant* de `UPDATE` **por coluna**, só nas colunas de cadastro — nunca em `status`, `archived_at` e `closing_date`.

**Aditiva:**

- tabelas `client_brand_sections`, `client_personas`, `client_threads`, `client_thread_comments`, com RLS forçada;
- índices: threads por `(client_id, section_key)` e `(client_id, persona_id)`; comentários por `(thread_id, created_at)`;
- permissões novas `cliente.visualizar`, `cliente.operar`, `cliente.cadastrar`, `cliente.arquivar`, `cliente.remover_usuario`, com os presets da seção 2.

**Funções `security definer`** — a forma decidida para efeito que não pode depender da RLS de outro módulo nem de uma pessoa:

| função | quem chama | faz |
|---|---|---|
| `app_private.archive_client(client_id)` | a rota de arquivar | confere `cliente.arquivar` do usuário corrente; arquiva, revoga convites pendentes, audita |
| `app_private.archive_due_clients()` | o job | arquiva todo cliente com `closing_date < hoje`, com os mesmos efeitos; audita com o job como origem |
| `app_private.set_client_closing_date(client_id, date)` | as rotas de agendar e desmarcar encerramento | confere `cliente.arquivar`; data hoje ou depois, ou nula para desmarcar; audita |
| `app_private.reactivate_client(client_id)` | a rota de reativar | confere `cliente.arquivar`; recusa nome em uso; reativa, audita |
| `app_private.set_client_membership_status(membership_id, status)` | as rotas de remover e reativar pessoa | confere `cliente.remover_usuario`; o vínculo precisa ser de cliente da agência corrente |

A última segue o precedente de `accept_invitation`: o *grant* de `UPDATE` em `client_memberships` é por coluna de propósito, e colocar `status` nele deixaria a policy existente — que só confere `user_id` — permitir que a pessoa se reative.

### RLS

| tabela | policy |
|---|---|
| `clients` | `INSERT`: `cliente.cadastrar`, `status = 'active'`. `UPDATE`: `cliente.operar` e `status = 'active'` no `using` e no `with check`. `SELECT` já existe |
| `client_brand_sections` | `SELECT`: membro da agência do cliente, ou vínculo de cliente. `INSERT`/`UPDATE`: `cliente.operar` e cliente ativo |
| `client_personas` | `SELECT`: membro da agência; vínculo de cliente só em `active`. `INSERT`/`UPDATE`: `cliente.operar` e cliente ativo |
| `client_threads` | `SELECT`: membro da agência ou vínculo de cliente, por `client_id`. `INSERT`: lado `agency` com `cliente.operar`, lado `client` com vínculo; cliente ativo; persona do assunto ativa. `UPDATE` (resolver): só `cliente.operar`, cliente ativo |
| `client_thread_comments` | `SELECT`: igual a threads. `INSERT`: mesma regra de lado; cliente ativo; persona ativa. Sem `UPDATE` e sem `DELETE` concedidos |

Nenhuma policy de outro módulo é alterada.

### Invalidação depois de escrever

| escrita | invalida |
|---|---|
| cadastrar | listagem de clientes |
| editar cadastro, foto | listagem, detalhe, cliente no portal |
| agendar ou desmarcar encerramento | listagem, detalhe |
| arquivar, reativar | listagem, detalhe, convites de portal, contextos do usuário |
| editar seção, criar, editar, arquivar ou desarquivar persona | estudo de marca, detalhe (preenchimento) |
| abrir thread, comentar | threads do assunto, comentários da thread, detalhe (resumo), listagem de clientes (selo) |
| resolver | threads do assunto, detalhe (resumo), listagem de clientes |
| remover, reativar pessoa | pessoas do portal, detalhe (resumo) |
| convidar, reenviar, cancelar | convites de portal, listagem de clientes (selo) |

## 7. Frontend

### Telas

| tela | rota | o que mostra | quem acessa |
|---|---|---|---|
| Carteira | `/agencia/:agenciaId/clientes` | cards de clientes para triagem | `cliente.visualizar` |
| Cadastrar | modal sobre a carteira | só o nome | `cliente.cadastrar` |
| Detalhe | `/agencia/:agenciaId/clientes/:clienteId/<aba>` | cabeçalho e seis abas | `cliente.visualizar` |
| Editar cadastro | modal sobre o detalhe | todos os campos do cadastro | `cliente.operar` |
| Portal — Início | `/portal/:clienteId` | saudação e próxima ação | vínculo de cliente |
| Portal — Marca | `/portal/:clienteId/marca` | estudo em leitura e conversas | vínculo de cliente |
| Portal — Calendário | `/portal/:clienteId/calendario` | esqueleto | vínculo de cliente |
| Portal — Relatórios | `/portal/:clienteId/relatorios` | esqueleto | vínculo de cliente |

**Duas intenções diferentes, e o designer precisa das duas.**

- **Área da agência — triar.** O Gestor de conta, com oito a vinte clientes, abre Clientes várias vezes por dia perguntando *qual cliente precisa de mim agora?*. Painel de plantão: o cliente com problema salta aos olhos, o cliente em dia fica quieto. Desktop primeiro.
- **Portal — conferir e aprovar.** O dono do negócio, sem familiaridade com ferramenta de agência, pelo celular, poucas vezes por semana. Vitrine do trabalho feito para ele: nenhum termo técnico, nenhum dado a interpretar, sempre uma próxima ação óbvia. **Celular primeiro.**

### Aba esqueleto

Conteúdos, Tarefas e Relatórios na agência, e Calendário e Relatórios no portal, **existem desde o MVP** e são preenchidas pelos seus módulos. Uma aba esqueleto diz que a área existe e o que ela vai mostrar — **nunca dado fictício, nunca controle que não funciona**. Nada nela pode parecer quebrado.

### Carteira — `/agencia/:agenciaId/clientes`

```
┌──────────────────────────────────────────────────────────────┐
│  Clientes                              [ + Cadastrar cliente ]│
│                                                              │
│  [ buscar por nome, razão social ou @.....]  Ativos ▾         │
│                                                              │
│  ┌──────────────────────────────────────────────────────────┐│
│  │ (foto)  Padaria Central        @padariacentral           ││
│  │         [2 sugestões aguardando] [convite pendente]      ││
│  │         ┄┄┄┄┄┄ pendentes · em revisão · atrasos ┄┄┄┄┄┄   ││
│  └──────────────────────────────────────────────────────────┘│
│  ┌──────────────────────────────────────────────────────────┐│
│  │ (AC)    Academia Corpo         @academiacorpo            ││
│  │         [encerra em 30/10]                               ││
│  │         ┄┄┄┄┄┄ pendentes · em revisão · atrasos ┄┄┄┄┄┄   ││
│  └──────────────────────────────────────────────────────────┘│
│                                                              │
│  ‹ 1 2 ›                                  20 de 34 clientes   │
└──────────────────────────────────────────────────────────────┘
```

| elemento | função |
|---|---|
| Card de linha inteira | um cliente por linha, com espaço para os sinais que Conteúdo e Tarefas vão trazer |
| Foto ou iniciais | sem foto, as iniciais do nome — nunca ícone genérico, igual ao crachá de Colaboradores |
| Selo *N sugestões aguardando* | threads abertas cujo último comentário é do cliente. É o sinal de triagem do MVP |
| Selo *encerra em dd/mm* | cliente com encerramento agendado |
| Selo *convite pendente* | só para quem tem `cliente.convidar_usuario` |
| Faixa de indicadores | reservada para pendentes, em revisão e atrasos; no MVP não mostra números |
| Ordem | quem tem sugestão aguardando vem primeiro — a tela é de triagem, não de consulta |
| Busca | nome, razão social ou @ — quem liga pode lembrar de qualquer um dos três |
| Filtro de status | Ativos (padrão) e Arquivados |
| Cadastrar cliente | ação primária, só para `cliente.cadastrar` |

Card arquivado, pelo filtro, aparece esmaecido e sem selos.

### Cadastrar — modal curto

```
│  Cadastrar cliente                                  │
│                                                     │
│  Nome     [...................................]     │
│           Os demais dados você completa depois.     │
│                                                     │
│                              [ Cadastrar ]          │
```

Só o nome, porque só ele é obrigatório: o cadastro começa numa ligação, e dez campos no primeiro contato fazem a pessoa inventar dado. Ao salvar, abre o detalhe do cliente novo. Nome em uso mostra o erro no próprio campo.

### Detalhe — `/agencia/:agenciaId/clientes/:clienteId/<aba>`

```
┌──────────────────────────────────────────────────────────────┐
│ ← Clientes                                                   │
│ (foto)  Padaria Central     Ativo · [encerra em 30/10]        │
│         @padariacentral                  [ Editar ]  [ ⋯ ]    │
├──────────────────────────────────────────────────────────────┤
│ Geral │ Conteúdos │ Tarefas │ Estudo de marca │ Relatórios │ Acessos │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│                      (conteúdo da aba)                       │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

A aba fica na URL, para o link ser compartilhável e o "voltar" funcionar.

**Menu `⋯`**, só para `cliente.arquivar`: **Encerrar contrato** (escolher a data), **Desmarcar encerramento** quando houver, **Arquivar agora**. Em cliente arquivado, a única ação do cabeçalho é **Reativar**.

A confirmação de arquivar diz o que acontece: o portal deixa de funcionar para as pessoas do cliente, convites pendentes são cancelados, nada é apagado. A de encerrar diz que tudo segue normal até a data, inclusive o portal.

### Aba Geral

```
│  Cadastro                              Estudo de marca          │
│  Razão social · CNPJ                   ████████░░░░  5 de 7     │
│  Segmento · Site                                                │
│  Contato: nome · telefone · e-mail     Conversas                │
│                                        2 aguardando a agência   │
│  Portal                                1 com resposta da agência│
│  3 pessoas com acesso                                           │
│                                                                 │
│  ┄┄┄┄┄┄┄┄┄┄┄┄┄ saúde do cliente (reservado) ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄     │
```

Resumo de como está tudo do cliente. No MVP mostra o que existe; a área de saúde — pendentes, atrasos, próximos posts — é reservada para Conteúdo e Tarefas. Cada bloco leva à aba correspondente. Campo de cadastro vazio aparece como "não informado", não some.

### Aba Estudo de marca

```
│  Branding                      editado por Ana · 12/10   [editar]│
│  (texto)                                                         │
│  Conversas (2)  ● 1 aguardando                     [+ conversa]  │
│  ────────────────────────────────────────────────────────────── │
│  Tom de voz                    …                                 │
│  Cores        ■ Vinho #7A1F2B   ■ Creme #F3E9DC           [editar]│
│  Arquétipo    Cuidador                                    [editar]│
│  Personas                                          [+ persona]   │
│    ┌ Dona Maria, 58 ┐ ┌ Lucas, 24 ┐   Arquivadas (1) ▾          │
│  Observações   …                                                 │
```

- Cada seção mostra o conteúdo, quem editou por último e quando, e as conversas daquela seção. Cada persona, as suas.
- **Editar** abre a seção em modo de edição no próprio lugar, só para `cliente.operar`.
- **Conversa**: lista das threads do assunto, abertas primeiro; abrir uma mostra os comentários, com o lado de cada autor visível — quem é da agência, quem é do cliente — e **Resolver** para `cliente.operar`. Thread resolvida continua legível; comentar nela a reabre.
- Personas arquivadas ficam recolhidas, com **Desarquivar**; as conversas delas são só leitura.
- Seção vazia: "Ainda não preenchida", com **Preencher** para `cliente.operar`.

### Aba Acessos

Só para `cliente.convidar_usuario`. O mesmo desenho da seção de convites de Colaboradores.

```
│  Pessoas com acesso ao portal               [ + Convidar ]  │
│  Maria Souza   maria@padaria.com   desde 02/09   [remover]  │
│  Removidas (1) ▾                                            │
│                                                             │
│  Convites aguardando aceite                                 │
│  joao@padaria.com   expira em 5 dias   [reenviar][cancelar] │
```

- **Convidar**: modal só com o e-mail.
- **Remover** pede confirmação: a pessoa perde o acesso ao portal deste cliente e é deslogada de tudo na hora, porque a sessão é global (2026-10-08, #411); as outras pessoas não são afetadas, e os vínculos dela com outros clientes continuam. Removidas ficam num filtro, com **Reativar**, que não cria sessão: a pessoa entra de novo.
- **Vazio**: "Ninguém deste cliente acessa o portal ainda", com **Convidar**.
- Convites vazios: a seção some.

### Abas Conteúdos, Tarefas e Relatórios

Esqueleto: o nome da área, uma frase do que ela vai mostrar, e nenhum controle.

### Portal — navegação

```
┌───────────────────────────┐
│ (logo agência) Padaria  ☰ │   ☰ = menu de conta: trocar de
│                           │       cliente, rever o tour, sair
│                           │
│        (conteúdo)         │
│                           │
├───────────────────────────┤
│ Início Calendário Marca Relatórios │
└───────────────────────────┘
```

Barra inferior com quatro itens, o padrão que um dono de negócio já sabe usar no celular. No desktop a mesma navegação vai para a lateral ou o topo — decisão do designer. Quem acessa mais de um cliente troca pelo menu de conta decidido em [`auth.md`](auth.md).

### Portal — Início

```
│  Olá, Maria                                 │
│                                             │
│  ┌───────────────────────────────────────┐  │
│  │ A agência respondeu 2 sugestões suas  │  │
│  │                         [ ver ]       │  │
│  └───────────────────────────────────────┘  │
│                                             │
│  ┄┄┄ conteúdos para aprovar (em breve) ┄┄┄   │
```

A próxima ação é **uma**: havendo threads abertas com resposta da agência, é "A agência respondeu N sugestões suas", que leva à Marca; senão, "Conheça o estudo da sua marca". O espaço de aprovação é reservado.

### Portal — Marca

- As seções em leitura, em linguagem de cliente. A SPEC registra a intenção; os rótulos — "Como sua marca fala" em vez de "Tom de voz" — são do designer.
- Cada seção e cada persona ativa tem **Sugerir**, que abre uma conversa nova, e mostra as conversas existentes.
- Em cada comentário da agência, **nome e foto** de quem respondeu.
- Seção não preenchida: "Sua agência está preparando esta parte" — nunca um campo vazio exposto, e sem **Sugerir**.
- Conversa resolvida mostra que a agência a concluiu; o cliente ainda pode comentar, e isso a reabre.

### Portal — tour

Na primeira entrada daquela pessoa naquele cliente, um tour guiado aponta os itens da navegação. Pode ser pulado e revisto pelo menu de conta. **Mostra só o que funciona**: no MVP, Marca e como sugerir. Calendário e Relatórios entram no tour com seus módulos.

### Variação por quem olha

| quem | na carteira e no detalhe |
|---|---|
| Admin, Owner | tudo |
| Gestor de conta | cadastra, edita, conversa, resolve; sem menu `⋯` e sem aba Acessos |
| Produção, Vendas, Financeiro | leem tudo, inclusive as conversas; sem **Editar**, sem **Cadastrar**, sem **+ conversa**, sem **Resolver**, sem aba Acessos, sem selo de convite |
| Qualquer um, em cliente arquivado | somente leitura; **Reativar** só para `cliente.arquivar` |

### Estados da tela

| estado | comportamento |
|---|---|
| **Vazio — carteira** | "Nenhum cliente ainda", com **Cadastrar cliente** para quem pode; para os demais, só o texto |
| **Vazio — arquivados** | "Nenhum cliente arquivado" |
| **Busca sem resultado** | "Nenhum cliente encontrado para "…"", com **limpar busca** — estado distinto de vazio |
| **Vazio — conversas** | "Nenhuma conversa sobre esta parte" |
| **Carregando** | skeleton na forma do card, na quantidade da página; na primeira carga do detalhe, cabeçalho e aba em skeleton |
| **Erro** | oferece repetir a ação |
| **Sem permissão** | não é tela: a aba ou o item não aparece, e a URL cai em "não encontrado". Cliente arquivado no portal cai no mesmo "não encontrado" |
| **Salvando** | estado no próprio controle; ao concluir, as queries da seção 6 são invalidadas |

## 8. Infraestrutura

- **Job agendado `clients.archive-due`**, no worker existente (pg-boss). Roda aos 10 minutos de cada hora em `America/Sao_Paulo` (a das 00:10 é a que vira o dia) e uma vez cada vez que o worker sobe, e chama `app_private.archive_due_clients()`, que é idempotente: uma virada perdida não deixa o portal aberto por um dia. É o **primeiro job agendado de negócio** do sistema.
- **Armazenamento de identidade** para a foto do cliente — criado por **#100**, de Colaboradores. Nenhum bucket novo.
- **Nenhum e-mail novo.** O convite de portal já tem o seu; notificação está fora (seção 10).

## 9. Impacto estrutural

- [x] **altera tabela que já existe**
- [x] **muda formato de resposta que outras rotas copiam**
- [ ] mexe em RLS de mais de um módulo
- [x] **muda como a autorização é avaliada**
- [ ] exigiria backfill

**É estrutural em três pontos, e os três estão registrados antes desta implementação**, em `decisions.md`:

1. **"ESTRUTURAL: os campos do cliente entram como colunas em `clients`".** A migration faz `alter table` numa tabela implantada e dispara o gate de CI. Não há backfill: toda coluna é anulável, e não existe dado real — tudo é local até o deploy.
2. **"ESTRUTURAL: a conversa com o cliente é uma tabela de threads por cliente, com assunto tipado".** É o formato que Conteúdo copia: ele acrescenta `content_id` em `client_threads`, não cria uma segunda tabela de conversa.
3. **"ESTRUTURAL: arquivar cliente é uma função `security definer` de escopo único, usada pelo job e pela rota".** Exceção à regra de que o worker age como um usuário. A forma — escopo único, auditada, sem outro efeito possível — é o modelo que a publicação agendada de Conteúdo deve seguir.

**RLS de outro módulo não é tocada.** Separar as permissões de convite por tipo reescreveria `invitations` e foi adiado com gatilho (seção 10). A estrutural conhecida **cliente na mídia** não é acionada: Clientes não usa `media_assets`.

## 10. Em aberto

| ponto | gatilho | quem decide |
|---|---|---|
| Liberar o portal a cliente real | Conteúdo entregar a aprovação | Pedro Vidal |
| Notificação — e-mail ou push — de conversa e de aprovação, com estado de lido | Conteúdo fechar o fluxo de aprovação | Pedro Vidal |
| Restringir a visibilidade de clientes por atribuição | a primeira agência precisar esconder um cliente de parte da equipe | Pedro Vidal |
| Gestor de conta gerenciar acessos do portal — **estrutural**: separar permissões de convite por tipo | o primeiro Gestor precisar convidar pessoa de cliente sem o Admin | Pedro Vidal |
| Integração com a Meta — métricas e anúncios no relatório | a decisão de publicar pela plataforma | Pedro Vidal |
| Relatório de dado interno do mês | Conteúdo e Tarefas existirem | Pedro Vidal |
| Vendas cadastrar cliente | Pipeline entrar no produto | Pedro Vidal |
| Cliente na mídia — **estrutural** | o bloco de impacto estrutural da entrevista de Conteúdo | Pedro Vidal |
| Fuso da data de encerramento por agência | a primeira agência fora do fuso de Brasília | Pedro Vidal |

## 11. Decisões registradas

Em [`docs/business/decisions.md`](../docs/business/decisions.md), 2026-09-26:

- Escopo do módulo de clientes: o cliente e a casca, nas duas frentes
- O portal nunca mostra o trabalho interno, e quem garante é a RLS
- Integração com a Meta fica fora do MVP, e publicar e medir decidem juntos
- O cliente sugere sobre a marca por conversa em thread, e esse é o modelo de conversa do produto *(pendente de validação)*
- Contato do cliente é cadastro; acesso ao portal é vínculo, e pode haver vários
- Permissões de clientes: todos veem todos, e cadastrar é administrativo
- Preset de clientes: o Gestor opera e cadastra, só o Admin arquiva e gerencia o portal
- Campos do cliente e forma do estudo de marca
- Estados de cliente, de acesso ao portal, de thread e de persona
- Regras invioláveis de clientes, garantidas pelo banco
- Contrato de cliente termina com aviso prévio, e o conteúdo além da data é cancelado
- A área de clientes é um painel de triagem, e o detalhe nasce com todas as abas
- O portal nasce com navegação de celular, tour do que funciona e sem notificação
- **ESTRUTURAL:** os campos do cliente entram como colunas em `clients`
- **ESTRUTURAL:** a conversa com o cliente é uma tabela de threads por cliente, com assunto tipado
- **ESTRUTURAL:** arquivar cliente é uma função `security definer` de escopo único, usada pelo job e pela rota
- Cliente na mídia fica para Conteúdo, com diagnóstico mais grave que o registrado
- A foto do cliente vive no armazenamento de identidade

Herdadas de [`autorizacao.md`](autorizacao.md) e [`colaboradores.md`](colaboradores.md): o contrato de listagem, `archived`/`removed`, as convenções de tela, o armazenamento de identidade e o desenho da seção de convites.

## 12. Recorte de implementação

**Épico [#114](https://github.com/Nocrato-Tech/ageniza/issues/114)**: 7 histories, 23 tasks, 9 pontos em aberto, nenhum débito.

| history | tasks | escopo |
|---|---|---|
| [#115](https://github.com/Nocrato-Tech/ageniza/issues/115) Ver a carteira | [#125](https://github.com/Nocrato-Tech/ageniza/issues/125) `GET` com ordem de triagem · [#134](https://github.com/Nocrato-Tech/ageniza/issues/134) carteira em cards | api · web |
| [#116](https://github.com/Nocrato-Tech/ageniza/issues/116) Cadastrar e ver o cliente | [#122](https://github.com/Nocrato-Tech/ageniza/issues/122) migration `estrutural` · [#124](https://github.com/Nocrato-Tech/ageniza/issues/124) cadastrar, ler, editar · [#126](https://github.com/Nocrato-Tech/ageniza/issues/126) foto · [#135](https://github.com/Nocrato-Tech/ageniza/issues/135) modal de cadastrar · [#136](https://github.com/Nocrato-Tech/ageniza/issues/136) detalhe e Geral · [#137](https://github.com/Nocrato-Tech/ageniza/issues/137) modal de editar | db · api · web |
| [#117](https://github.com/Nocrato-Tech/ageniza/issues/117) Estudo de marca | [#127](https://github.com/Nocrato-Tech/ageniza/issues/127) rotas do estudo e personas · [#138](https://github.com/Nocrato-Tech/ageniza/issues/138) aba Estudo de marca | api · web |
| [#118](https://github.com/Nocrato-Tech/ageniza/issues/118) Conversar sobre a marca | [#128](https://github.com/Nocrato-Tech/ageniza/issues/128) serviço e rotas da agência `estrutural` · [#130](https://github.com/Nocrato-Tech/ageniza/issues/130) rotas do portal · [#142](https://github.com/Nocrato-Tech/ageniza/issues/142) conversa na agência · [#143](https://github.com/Nocrato-Tech/ageniza/issues/143) Marca no portal | api · web |
| [#119](https://github.com/Nocrato-Tech/ageniza/issues/119) Encerrar o contrato | [#123](https://github.com/Nocrato-Tech/ageniza/issues/123) funções `security definer` `estrutural` · [#131](https://github.com/Nocrato-Tech/ageniza/issues/131) encerrar, arquivar, reativar · [#133](https://github.com/Nocrato-Tech/ageniza/issues/133) job diário `estrutural` · [#139](https://github.com/Nocrato-Tech/ageniza/issues/139) ações no detalhe | db · api · infra · web |
| [#120](https://github.com/Nocrato-Tech/ageniza/issues/120) Acessos ao portal | [#132](https://github.com/Nocrato-Tech/ageniza/issues/132) rotas de acessos · [#140](https://github.com/Nocrato-Tech/ageniza/issues/140) aba Acessos | api · web |
| [#121](https://github.com/Nocrato-Tech/ageniza/issues/121) Portal do cliente | [#129](https://github.com/Nocrato-Tech/ageniza/issues/129) leituras do portal · [#141](https://github.com/Nocrato-Tech/ageniza/issues/141) navegação e Início · [#144](https://github.com/Nocrato-Tech/ageniza/issues/144) tour | api · web |

**Em aberto:** [#145](https://github.com/Nocrato-Tech/ageniza/issues/145) liberar o portal · [#146](https://github.com/Nocrato-Tech/ageniza/issues/146) notificação · [#147](https://github.com/Nocrato-Tech/ageniza/issues/147) visibilidade por atribuição · [#148](https://github.com/Nocrato-Tech/ageniza/issues/148) Gestor nos acessos `estrutural` · [#149](https://github.com/Nocrato-Tech/ageniza/issues/149) Meta · [#150](https://github.com/Nocrato-Tech/ageniza/issues/150) relatório interno · [#151](https://github.com/Nocrato-Tech/ageniza/issues/151) Vendas cadastrar · [#152](https://github.com/Nocrato-Tech/ageniza/issues/152) cliente na mídia `estrutural` · [#153](https://github.com/Nocrato-Tech/ageniza/issues/153) fuso por agência `estrutural`.

### A ordem que a dependência impõe

A migration [#122](https://github.com/Nocrato-Tech/ageniza/issues/122) vem **primeira** e destrava seis tasks de API e as funções [#123](https://github.com/Nocrato-Tech/ageniza/issues/123), que por sua vez destravam encerramento, acessos e o job. A foto [#126](https://github.com/Nocrato-Tech/ageniza/issues/126) também espera **#100**, de Colaboradores.

**Doze das vinte e três tasks não esperam o designer.** As onze de `escopo:web` nascem com o esboço, a tabela de elementos e os estados no corpo da própria issue, e esperam com `aguardando-design`. A cadeia de conversa ([#142](https://github.com/Nocrato-Tech/ageniza/issues/142) → [#143](https://github.com/Nocrato-Tech/ageniza/issues/143) → [#144](https://github.com/Nocrato-Tech/ageniza/issues/144)) tem ondas altas porque o componente de conversa nasce na agência e é reaproveitado no portal. É dependência de componente, não prioridade.
