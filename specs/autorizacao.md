# Autorização e transversais

| | |
|---|---|
| **Status** | em revisão |
| **Submódulos** | catálogo de permissões · papéis e presets · ciclo de vida de entidade e vínculo · contrato de listagem · convenções de tela |
| **Sessões** | 2026-09-24 (sessão 0) |
| **Decidido por** | Pedro Vidal, em sessão |

> Esta não é uma SPEC de módulo comum: não há tela própria nem rota nova. Ela define o que **todos** os módulos seguintes herdam. Um módulo que contrarie qualquer coisa daqui está reabrindo uma decisão, não interpretando-a.

## 1. Propósito

Fixar como a autorização é avaliada, como entidades e vínculos terminam, como toda listagem responde e o que toda tela faz nos estados de exceção — antes que o primeiro módulo decida isso por acidente e vire o modelo copiado.

### Não resolve

- **Quais permissões cada módulo tem.** Isso é da entrevista de cada módulo.
- **Papéis personalizados por agência.** Fora do MVP — ver seção 10.
- **Trial, plano e cobrança.** Previstos, não desenhados — ver seção 10.
- **Auditoria de alteração de campo.** Continua como estrutural não resolvida em `structural-changes.md`.
- **Retenção e LGPD.** A purga física vive nesse fluxo, que é separado e não tem rota de produto.

## 2. Atores e autorização

### Como a autorização é avaliada

Duas barreiras, com a mesma regra dos dois lados:

1. **Banco** — `app_private.has_agency_permission(agency_id, permission)`, da migration `20260919000000_tenancy_and_invitations.mjs`. Owner de agência `active` passa por posse; qualquer outro passa por `agency_memberships` ativo → `roles` → `role_permissions`, com o papel restrito a `role.agency_id is null or role.agency_id = agency.id`.
2. **API** — `requireAgencyAccess` carrega `isOwner`, `roleKey` e o conjunto de permissões em `request.tenant`; `requirePermission(key)` libera Owner e exige a chave para o resto (`apps/api/src/modules/tenancy/guards.ts`).

O guard espelha a policy de propósito: uma falha na API ainda encontra a RLS.

### Formato do catálogo

| forma | quando usar |
|---|---|
| `<modulo>.visualizar` | ver o módulo. Existe em **todo** módulo, mesmo onde todos os presets a recebem |
| `<modulo>.operar` | o uso normal do módulo |
| `<modulo>.<acao>` | apenas ação **administrativa ou destrutiva** |

Permissões que já existem, todas do terceiro tipo e todas concedidas apenas ao preset `admin`: `colaborador.convidar`, `cliente.convidar_usuario`, `convite.reenviar`, `convite.cancelar`.

### Papéis

Cinco papéis de sistema (`is_system = true`, `agency_id is null`): `admin`, `account_manager`, `production`, `sales`, `finance`. Os quatro últimos estão **sem nenhuma permissão** e continuam assim até que a entrevista do módulo correspondente preencha o preset.

**Owner não é papel.** É `agencies.owner_user_id`, e tem acesso total por posse.

**Cargo/função não é papel.** É `agency_memberships.job_title`, dado profissional que não concede autorização.

### A linha que toda SPEC de módulo precisa ter

| capacidade | permissão | admin | gestor de conta | produção | vendas | financeiro |
|---|---|---|---|---|---|---|

SPEC de módulo sem essa linha preenchida está incompleta.

## 3. Entidades e campos

Tudo já existe. Nada é criado por esta SPEC.

| tabela | o que guarda | o que importa |
|---|---|---|
| `permissions` | o catálogo | `key` é a chave primária: a chave **é** a identidade |
| `roles` | papel de sistema ou de agência | `roles_system_agency_check` garante `is_system` se e somente se `agency_id is null` |
| `role_permissions` | o que cada papel pode | `(role_id, permission_key)` |
| `agency_memberships` | vínculo pessoa↔agência | `role_id`, `job_title`, `status`, e `unique (agency_id, user_id)` |
| `client_memberships` | vínculo pessoa↔cliente | contexto separado: colaborador não entra no portal por ser colaborador |

## 4. Estados e transições

### Vocabulário

| termo | aplica-se a | significa |
|---|---|---|
| `archived` | entidade de negócio | guardada, recuperável, fora das listagens por padrão |
| `removed` | vínculo entre pessoa e tenant | vínculo desfeito |

Toda entidade de negócio nova nasce com `status` e um estado terminal reversível.

### Vínculo de colaborador

```
active  → removed   # exige a permissão administrativa do módulo de colaboradores
removed → active    # o MESMO registro, por unique (agency_id, user_id)
```

O papel anterior **não volta sozinho**: quem retorna à agência pode retornar em outra função, e herdar a permissão antiga em silêncio é exatamente o caso que esta regra existe para impedir. Como o registro é o mesmo, isso significa que a reativação exige o papel no corpo em vez de deixar o valor antigo intacto — a rota é declarada na SPEC de Colaboradores.

### Entidade de negócio

```
active → archived → active
```

Não existe transição para exclusão física por rota.

## 5. Regras invioláveis

1. Rota que exige permissão devolve **403** para membro ativo sem a chave, e a mesma operação é negada pela RLS se a API falhar.
2. Agência inexistente, suspensa ou inacessível devolvem **404 indistinto** — nunca 403, que confirmaria a existência.
3. Colaborador da agência **sem** `client_memberships` ativo não acessa o portal daquele cliente.
4. Membership apontando para papel de **outra** agência não concede nada.
5. Owner de agência `active` passa em qualquer permissão daquela agência.
6. Papel de sistema tem `agency_id is null`; papel de agência tem `agency_id` preenchido. O contrário é rejeitado pelo banco.
7. Nenhuma rota da aplicação apaga fisicamente entidade de negócio.
8. **Reativação de vínculo nunca herda a autorização anterior**: o papel é informado de novo, sempre. A rota que materializa isso é declarada na SPEC de Colaboradores.
9. Listagem devolve `pageSize` de **no máximo 100**, qualquer que seja o pedido.
10. Listagem **não** devolve entidade `archived` sem que a requisição peça explicitamente.
11. Depois de uma escrita bem-sucedida, a tela **nunca** exibe o dado anterior.

## 6. Backend

**Nenhuma rota nova.** O que esta SPEC fixa é o contrato que as rotas dos próximos módulos seguem.

### Listagem

- Paginação **por página**, com `packages/contracts/src/pagination.ts`: `{ data, meta }`, e `meta` com `page`, `pageSize`, `totalItems`, `totalPages`.
- **Teto global** de `pageSize`: 100. **Tamanho padrão**: declarado por rota na SPEC do módulo — não há valor global.
- **Ordenação e filtro**: parâmetros nomeados por rota (`sort=name:asc`, `status=active`), declarados na SPEC. Parâmetro não declarado não existe; não há linguagem de consulta genérica na query string.
- **Bloco de resumo não pagina**: `limit` fixo declarado na SPEC, sem `page` e sem `totalItems`, com link para a listagem completa.

### Persistência

Permissão nova é `insert` em `permissions` e `role_permissions` — migration aditiva, sem alcance estrutural.

### RLS

Nenhuma policy nova. Toda policy de módulo novo chama `app_private.has_agency_permission` com a chave do módulo; nenhuma reimplementa a resolução de papel.

## 7. Frontend

Não há tela. Há as convenções que toda tela herda.

### Estados de exceção

| estado | comportamento |
|---|---|
| **Sem permissão** | **não é uma tela.** O item não aparece no menu; a URL digitada na mão cai no mesmo "não encontrado" de um recurso inexistente |
| **Vazio** | texto e **ação primária de saída** declarados na SPEC de cada listagem |
| **Erro** | sempre oferece repetir a ação; nunca apenas informa |
| **Carregando** | skeleton com a forma do conteúdo na primeira carga; sem spinner de tela cheia depois dela |

A regra de "sem permissão" existe porque `guards.ts` devolve 404 indistinto de propósito. Uma tela de acesso negado transformaria esse 404 num oráculo de existência.

### Carregamento

Três situações, tratamentos diferentes — tratá-las igual é o que produz a tela que pisca a cada navegação.

| situação | tratamento |
|---|---|
| **Primeira carga**, sem dado | skeleton com a forma do conteúdo: linhas da tabela, blocos do card. Reserva o layout, e o conteúdo não pula quando chega |
| **Revalidação**, com dado em tela | a tela não muda; o dado continua visível |
| **Ação pontual** (submit) | o estado vive no próprio controle, com confirmação ao terminar. Nunca um overlay que trave o fluxo |

**Não existe spinner de tela cheia depois da primeira carga.**

### Atualização depois de escrever

`apps/web/src/query.ts` usa `staleTime` de 30s e não refaz busca ao focar a janela: voltar a uma tela em menos de meio minuto serve o cache. Isso significa que navegação **não** é o que atualiza a tela depois de uma escrita.

**Toda mutação invalida as queries que afeta**, e a SPEC de cada módulo declara quais. Salvar e continuar exibindo o dado anterior é defeito, não latência. Sem tempo real e sem polling: `staleTime` deixa de governar a atualização e passa a ser apenas economia de requisição.

### Navegação

O menu é construído a partir das permissões do contexto ativo — e é **apenas UX**. Descobrir ou montar a URL na mão não concede nada, porque a autorização é validada no backend em toda operação.

## 8. Infraestrutura

Nada. Nenhum job, armazenamento, e-mail ou fila.

## 9. Impacto estrutural

- [ ] altera tabela que já existe
- [ ] muda formato de resposta que outras rotas copiam
- [ ] mexe em RLS de mais de um módulo
- [ ] muda como a autorização é avaliada
- [ ] exigiria backfill

**Nenhum.** A sessão fez o inverso: fechou duas estruturais conhecidas — formato de listagem e exclusão reversível — e adiou uma com gatilho. `structural-changes.md` já reflete isso.

O que **passa** a ser estrutural daqui em diante: mudar o formato de `meta` depois da primeira listagem publicada, trocar o vocabulário `archived`/`removed` depois de tabelas o usarem, ou alterar `app_private.has_agency_permission`.

## 10. Em aberto

| ponto | gatilho | quem decide |
|---|---|---|
| Papéis personalizados por agência | uma agência precisar de uma combinação que os cinco presets não expressam | Pedro Vidal |
| Trial, plano e cobrança | o primeiro limite — clientes, colaboradores ou armazenamento — que precise ser imposto **por plano** e não por configuração da operação | Pedro Vidal |

## 11. Decisões registradas

Todas em [`docs/business/decisions.md`](../docs/business/decisions.md), datadas de 2026-09-24:

- Permissão nomeada é híbrida: módulo para ver e operar, ação para o administrativo
- Preset de papel é preenchido na entrevista do módulo, não antecipadamente
- `archived` e `removed` coexistem, e nenhuma rota exclui entidade de negócio
- Listagem é paginada por página, com filtro e ordenação nomeados por rota
- Teto de página é global, tamanho é por rota, e bloco de resumo não pagina
- Arquivado fica fora da listagem até ser pedido
- `<modulo>.visualizar` existe mesmo onde hoje todos veem tudo
- Papéis personalizados ficam fora do MVP, e a única capacidade não delegável hoje é a posse
- Cobrança existe no plano do produto, não no sistema, e tem gatilho
- "Sem permissão" não é uma tela: a interface espelha o 404 do backend

## 12. Recorte de implementação

Esta SPEC **não gera history**: não há capacidade nova a entregar. Ela produz as convenções que as SPECs seguintes consomem, e as issues de acompanhamento abaixo.

Isso não a isenta do portão: nenhum módulo abre enquanto o anterior não estiver com SPEC aprovada e recorte feito. "Recortado" é o recorte existir — não ter pelo menos uma history.

| issue | tipo |
|---|---|
| Papéis personalizados por agência | `em-aberto` |
| Trial, plano e cobrança | `em-aberto` |
| Frontend de autenticação e convite nunca desenhado | `debito` |
| ~~Auth do frontend ainda é Supabase~~ — [#51](https://github.com/Nocrato-Tech/ageniza/issues/51) | `debito` · criada |

A validação real destas convenções acontece na primeira listagem implementada, que será a de Clientes.
