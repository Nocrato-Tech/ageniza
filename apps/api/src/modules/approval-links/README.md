# Módulo `approval-links` (issue #712)

O link de aprovação do e-mail "conteúdos para aprovar": a pessoa com acesso ao portal de um cliente, **com ou sem conta**, abre um lote de
conteúdos, vê a prévia de celular e aprova ou pede ajuste, sem login. Decisões:
`docs/business/decisions/2026-10-26-estrutural-o-e-mail-de-aprovacao-leva-um-link-que-aprova-sem-login.md`,
`2026-10-27-estrutural-o-link-de-aprovacao-decide-pelo-contexto-da-transacao-e-abre-a-conversa-como-acesso.md` e
`2026-10-27-o-link-de-aprovacao-sessao-de-duas-horas-limites-e-o-que-a-pagina-le.md`. A tela é a #717.

Nenhuma rota daqui tem conta: a pessoa tem um e-mail e um link, e a única credencial é o **cookie** pelo qual o token do link foi trocado.
Toda chamada vai ao banco **sem ator** na transação, e o banco confere a revogação **a cada uso**; a rota só traduz.

| método | rota | o que faz |
|---|---|---|
| `POST` | `/portal-approval/session` | troca o token (no corpo) pelo cookie `ageniza_approval` |
| `GET` | `/portal-approval/batch` | lê o lote: nomes, endereço do acesso, validades e os conteúdos com a prévia |
| `GET` | `/portal-approval/contents/:contentId/media/:assetId/url` | URL assinada, de no máximo 5 minutos, de um arquivo do lote |
| `POST` | `/portal-approval/contents/:contentId/approve` | Aprovar, com a `revision` lida |
| `POST` | `/portal-approval/contents/:contentId/request-changes` | Pedir ajuste, com a `revision` lida e o `comment` |

A referência completa (corpos, erros, exemplos) está em `docs/api/README.md` (módulo `approval-link`), gerada do catálogo.

## O contrato para a tela

1. **O e-mail leva `APP_PUBLIC_URL/aprovar#<token>`.** O token (43 caracteres, base64url) vem depois do `#`, que o navegador não envia ao servidor. A tela lê
   `location.hash`, **apaga o fragmento da barra de endereço** (`history.replaceState`) e faz `POST /portal-approval/session` com
   `{ token }` no corpo, com `credentials: 'include'`. Nunca ponha o token numa consulta (`?`): qualquer parâmetro na URL é `400`. Ponha
   `<meta name="referrer" content="no-referrer">` na página, e não grave o token em `localStorage`, em log nem em evento de rastreio.
2. **Abrir não decide.** O `POST /session` só cria a sessão, e o `GET /batch` só lê. Aprovar e Pedir ajuste são cliques que fazem `POST`.
3. **`canDecide`** é o que manda desenhar os dois botões: verdadeiro só para o conteúdo que aguarda aprovação. Os outros aparecem com o estado de
   agora e sem botões (`approved`, `adjusting`, `published`), e o em produção traz só título, dia e formato.
4. **Um erro só para o link morto:** `404 APPROVAL_LINK_INVALID`, sem dizer se venceu, foi removido ou a agência parou. É um estado só na tela.
   Com a sessão vencida (2 horas) e o link vivo, o mesmo e-mail abre uma sessão nova.
5. **Decidir devolve o conteúdo** no estado de depois (`PortalApprovalContent`). `409 CONTENT_REVISION_CHANGED` pede para recarregar o lote;
   `409 CONTENT_NOT_AWAITING_APPROVAL` quer dizer que outra pessoa decidiu antes (recarregar mostra o estado novo); `400` é comentário em branco,
   invisível ou com mais de 5000 bytes.
6. **A mídia:** `coverAssetId` e `media[].id` pedem a URL assinada em `GET .../contents/:contentId/media/:assetId/url?variant=original|thumbnail`;
   a URL vale minutos, então peça quando for mostrar e peça de novo se expirar (`expiresAt`).
7. **"Criar conta para ver o portal"** leva a `/criar-conta` com `batch.personEmail` preenchido. A página nunca diz se o endereço já tem conta.
8. `429 RATE_LIMITED` traz `Retry-After`.

## O que o banco garante e a rota não repete

- As tabelas do link (`client_portal_approval_links`, `_link_contents`, `_sessions`) não têm grant nem policy para a aplicação; só as funções
  `security definer` de `20261027090200` as leem e escrevem, e guardam **só o hash** do token e da sessão.
- O link é de um **acesso**, de uma **geração** do acesso e de um **lote**; vale 7 dias (um `check` impede mais). Remover o acesso avança a geração
  e mata o link para sempre; reativar não o traz de volta. Cliente arquivado, agência suspensa ou somente leitura e link ou sessão vencidos o matam,
  conferidos a cada leitura e a cada decisão (`portal_approval_link_is_live`), com as travas do acesso e do cliente para uma remoção ou um
  arquivamento em curso serem esperados e vistos.
- A decisão grava o acesso (`approved_by_portal_access_id`, `author_portal_access_id`, `opened_by_portal_access_id`), e só a função da decisão
  consegue: ela liga o acesso à transação em `app_private.portal_approval_context`, e os gatilhos de `contents`, `client_threads` e
  `client_thread_comments` só aceitam um acesso como autor se é o que está ali.
- A função que grava sem ator pergunta `agency_accepts_writes` ela mesma e recusa com `A0090` (o gatilho do somente leitura deixa passar escrita sem
  ator, e foi o requisito da revisão do #725). A rota responde o mesmo `404` do link morto.

## O que a rota faz

Validação por `docs.schemas` (o mesmo objeto do catálogo), `Cache-Control: no-store` em toda resposta (como `onRequest`, para valer também nos erros),
nenhuma consulta aceita, `HEAD` não exposto, limites por IP e por hash do token ou da sessão (`rate-limit.ts`), cookie com `HttpOnly`,
`SameSite=Strict` e `Path` do módulo (`tokens.ts`, `policy.ts`), erros traduzidos em `errors.ts` (os do portal, mais `APPROVAL_LINK_INVALID`).
O CSRF é o global (a origem do app em todo `POST`), e a API responde `Referrer-Policy: no-referrer`.

## Testes

`approval-links.integration.test.ts` (HTTP: cookie, token fora da URL e do log, abrir não decide, o lote, os mesmos efeitos e recusas do portal, a
revogação, a mídia, os limites e a agência lendo o "aprovado por" do link), `tokens.test.ts` e `rate-limit.test.ts`. O banco é provado em
`packages/database/test/portal-approval-links.integration.test.ts`, e o worker em `apps/worker/src/client-content-email-job.integration.test.ts`.
