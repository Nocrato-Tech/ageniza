# Portal, Início: os conteúdos esperando aprovação passam à frente e o roteiro de hoje, pelo dia de São Paulo

**Data.** 2026-10-11

**Contexto.** A #271 preenche o Início do portal (`specs/conteudo.md` seção 7): "N conteúdos esperando sua aprovação" e o roteiro de stories de hoje, com "Marcar como gravado". A API já serve os dois: o Início (`GET /clients/:clientId`) traz `home.contentsAwaitingApproval` (#548), a consulta por período e `POST .../recorded` dos roteiros do portal são da #258, e a lista dos conteúdos a aprovar é da #257. A SPEC e a issue deixam em aberto, e alguém tentaria de novo:

**Decisão.**

1. **A próxima ação do Início passa a ter uma ordem.** Quando há conteúdo esperando a aprovação, o cartão é "N conteúdos esperando sua aprovação" (singular com 1), e ele toma o lugar da próxima ação que já existia; sem nenhum, volta a ser "A agência respondeu N sugestões suas" e, sem isso, o estudo da marca. O número é o `home.contentsAwaitingApproval` da API, o mesmo que a lista de aprovação conta, e não um número calculado pela tela.
2. **O link do cartão leva ao item "Calendário" da barra** (`/portal/:clienteId/calendario`), que é onde a lista dos conteúdos do portal vai morar (#269): a SPEC chama a rota de `/portal/:clienteId/conteudos` e a barra ainda se chama Calendário. Quando a #269 renomear o item e a rota, o link muda junto.
3. **O roteiro de hoje é o do dia de São Paulo.** A tela pede o período de um dia (`from` e `to` iguais ao dia de hoje em São Paulo, não em UTC) e mostra os roteiros enviados ou gravados dele, em ordem; sem nenhum, o bloco não existe. O dia é lido quando o Início é desenhado: uma tela deixada aberta através da meia-noite continua no dia anterior até a próxima navegação, que relê o portal (a tela não cria timer para isso).
4. **"Marcar como gravado" só existe no roteiro enviado.** O roteiro gravado mostra "Gravado por {nome} em dd/mm" (o dia em São Paulo, e só "Gravado" se a API não trouxer o nome) e nenhum botão; o rascunho nunca chega (a API não o devolve e o contrato da tela o recusa). Com mais de um roteiro no dia, cada um tem o seu título e o botão leva o número ("Marcar como gravado o roteiro 2").
5. **Erro ao marcar.** O roteiro continua como estava e o botão volta a funcionar; o texto é da tela (sem o do servidor): `409 TRY_AGAIN` pede para tentar de novo, os outros `409` dizem que o roteiro mudou, e a tela relê o dia (o roteiro pode já estar gravado por outra pessoa do cliente), `404` diz que ele não existe mais, `403` e o resto têm o seu texto. Um erro ao ler o roteiro é do bloco ("Não foi possível carregar o roteiro de hoje." com "Tentar de novo") e não leva o resto do Início.
6. **Celular primeiro.** Texto, orientação e botão quebram e encolhem (`overflow-wrap: anywhere`, caixas com `min-width: 0`, botão na largura toda): o texto do servidor é sempre texto, com as quebras de linha dele.

**Consequência.**

- Só tela: nenhuma rota, tabela ou permissão nova; o `PortalHomeSchema` e os contratos dos roteiros do portal ficam como estão.
- Quem for tirar o item "Calendário" da barra para pôr "Conteúdos" (#269) precisa trocar o destino do cartão.
- O texto reservado "conteúdos para aprovar (em breve)" some do Início.

**Origem.** Issue #271; SPEC `specs/conteudo.md` seções 3, 4, 6 e 7; #548 (contagem no Início), #257 e #258 (APIs do portal).

**Validação.** Pendente de validação do dono.
