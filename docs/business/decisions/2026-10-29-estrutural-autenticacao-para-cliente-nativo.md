# ESTRUTURAL: autenticação para o cliente nativo (app Expo)

**Data.** 2026-10-29

**Contexto.** O time mobile entrega o app em Expo em duas semanas e não consegue entrar pelo app: a API foi feita para o navegador, que guarda o cookie de sessão sozinho e manda `Origin` em toda escrita. O app nativo não faz nenhuma das duas coisas. O dono pediu para tocar direto, sem issue, com o escopo mínimo, e a mudança toca autenticação e sessão (revisão de segurança independente antes do merge).

**Decisão.**

1. **O app entra com e-mail e senha e com o Google, e a sessão é a mesma.** Expiração (7 dias sem uso, teto de 30), revogação ao remover colaborador, "sair de todos os dispositivos" e a recusa da conta sem e-mail confirmado valem para o app exatamente como para o navegador. Não existe sessão "do app" com regra própria.
2. **O app guarda o cookie que a API emitiu** (no SecureStore do aparelho) e o devolve no cabeçalho `Cookie` de cada chamada, como o navegador faria. Não há token novo, nem na URL nem no corpo.
3. **O app se identifica pelo esquema dos seus deep links** (ex.: `ageniza://`), no cabeçalho `expo-origin` que o cliente Expo do Better Auth já manda (ou em `Origin`). A API só reconhece esse esquema quando o ambiente o lista em `MOBILE_APP_ORIGINS`. **Vazia (o padrão), o comportamento é o de hoje:** a origem do app é recusada com `403 CSRF_REJECTED`, como qualquer origem desconhecida. Produção só liga quando o dono pedir; o dev liga.
4. **O `expo-origin` só vale quando a requisição não traz `Origin`.** O navegador sempre manda `Origin` numa escrita, então uma página de terceiros não consegue se passar pelo app; um `Origin` errado nunca é salvo pelo `expo-origin`.
5. **O Google, quando o fluxo começou no app, volta para o deep link do app** com a sessão, e só para um esquema da mesma lista. Um esquema fora da lista, um endereço web, credenciais ou fragmento no destino são recusados antes de chegar ao Google (`400 VALIDATION_ERROR`); se o destino sair da lista entre a ida e a volta, a volta cai na tela de erro da web. Quando o Google recusa, o app volta ao deep link com `?erro=google`, sem dizer o motivo, como a web.

**Consequência.** O app consegue entrar e chamar as rotas autenticadas sem tocar no desenho de sessão. Um esquema de deep link próprio não é exclusivo do app: outro aplicativo instalado no mesmo aparelho pode registrar o mesmo esquema e ler a sessão que o Google devolve no deep link. O risco é aceito para o lançamento e a mitigação é trocar o esquema por universal links / app links (domínio verificado) antes de abrir o app a um público amplo. O Better Auth entra com o pacote oficial `@better-auth/expo`, fixado na mesma versão do `better-auth`.

**Origem.** Pedido do dono em 2026-10-29 (app mobile Expo), sem issue. Os itens 4 e 5 são leituras do implementador onde o pedido não dizia o detalhe.

**Validação.** Pendente de validação do dono.
