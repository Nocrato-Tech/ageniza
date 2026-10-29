# Link de aprovação

Cada e-mail "conteúdos para aprovar" leva um link `/aprovar#<token>`, próprio de cada pessoa do portal. Quem abre o link aprova ou pede ajuste **sem login e sem conta**, e só nos conteúdos daquele lote. Corpo, resposta e erros de cada rota estão na [referência da API](../../api/README.md).

## Rotas

| método | rota | acesso | o que faz |
|---|---|---|---|
| `POST` | `/portal-approval/session` | público, com o token do link | troca o token pela sessão de aprovação |
| `GET` | `/portal-approval/batch` | sessão de aprovação | lê o lote, com a prévia de celular de cada post |
| `GET` | `/portal-approval/contents/:contentId/media/:assetId/url` | sessão de aprovação | URL assinada de uma mídia do lote |
| `POST` | `/portal-approval/contents/:contentId/approve` | sessão de aprovação | aprova um conteúdo do lote |
| `POST` | `/portal-approval/contents/:contentId/request-changes` | sessão de aprovação | pede ajuste, com comentário obrigatório |

## Fluxo

1. O token vem no **fragmento** da URL, a parte depois do `#`. O fragmento não vai para servidores nem para logs. Leia o token do link, apague-o da URL e não o registre em lugar nenhum.
2. `POST /portal-approval/session` com `{ "token" }` troca o token por uma **sessão de aprovação**. Essa sessão é um cookie próprio, separado da sessão de login. A resposta traz `sessionExpiresAt` e `linkExpiresAt`.
3. `GET /portal-approval/batch` lê o lote.
4. Para cada mídia, peça a URL assinada. Ela dura poucos minutos; se expirar, peça outra.
5. Para cada conteúdo, aprove ou peça ajuste. O pedido de ajuste exige comentário.
6. A tela pode oferecer "Criar conta para ver o portal", com o e-mail já preenchido.

## Regras

- O link vale **7 dias** e só abre os conteúdos do lote daquele e-mail.
- A decisão fica registrada no acesso ao portal daquela pessoa. Uma pessoa basta para aprovar.
- A revogação é conferida a cada leitura e a cada decisão. O link para de funcionar quando:
  - o acesso da pessoa foi removido;
  - o cliente foi arquivado;
  - a agência foi suspensa ou está em modo leitura.
- Reativar o acesso **não** faz um link antigo voltar a funcionar.
- As pessoas do portal que ainda não têm conta também recebem esse e-mail.

## Erros

- `404 APPROVAL_LINK_INVALID`: o link venceu, foi revogado ou não existe. Mostre uma mensagem neutra, sem dizer qual foi o motivo.
- `429 RATE_LIMITED`: tentativas demais.
