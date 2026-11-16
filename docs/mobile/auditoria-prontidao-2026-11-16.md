# Prontidão mobile — auditoria de 16/11/2026

Não há medição que sustente “80% pronto”. Há aplicação web mobile autenticada em operação no dev, funcionalidades de negócio implementadas e lacunas distintas de produto, integração e lançamento. Uma exportação não prova todos os fluxos, desempenho físico ou prontidão comercial.

## Base e método

- App observado: [dev oficial](https://dev.ageniza.com.br/app-mobile/), sessão existente na agência de demonstração, com dados fictícios persistidos pela API.
- `/app-mobile/`, `/api/health` e `/version.txt`: HTTP 200; saúde `ok`; versão `2a1148bb405562824c07d458b0bec9c6d6934536`, novamente conferida nesta auditoria.
- `origin/develop` atualizado para o mesmo commit. O checkout original estava em `e5e03165` com alterações locais extensas de ML/Instagram. Estas foram preservadas e estão fora do PR visual.
- Evidência separada: navegação autenticada no dev; inspeção de código/contratos/SPECs; issues e respostas; testes de software; inspeção visual local dos componentes reais com respostas de teste identificadas. Os screenshots locais não comprovam integração com o servidor nem publicação da reformulação.
- Não houve pagamento real, conexão Meta, publicação social, alteração da VPS, acesso a segredos ou teste em aparelho físico.

## Prioridades e dependências

| Prioridade | Lacuna | Estado e próximo passo verificável |
|---|---|---|
| P0 para ML real | Histórico, avaliação e promoção | Revisar/integrar a implementação local de captura/treino/abstenção; aprovar retenção/proveniência e piloto; ativar coleta autorizada; acumular trajetórias reais completas; comparar candidato e baseline em corte temporal; aprovar relatório por agência antes de promover. [#817](https://github.com/Nocrato-Tech/ageniza/issues/817), [#888](https://github.com/Nocrato-Tech/ageniza/issues/888). |
| P0 para contratação real | Adaptador de pagamento | Implementar no pacote existente o provedor aprovado, confirmação autenticada, idempotência, retornos/falhas e conciliação; testar em ambiente apropriado antes de cobrança real. Não basta preencher uma chave. [#819](https://github.com/Nocrato-Tech/ageniza/issues/819). |
| P0 para produção com dados reais | Evidência operacional | Conferir ambiente de produção, backup cifrado e restauração, storage, e-mail, alarmes e rollback conforme runbooks. A auditoria externa do dev não comprova esses itens. |
| P1 | Recuperação de cobrança pendente | O mobile mantém `charge` somente em `useState`; sair da tela/recarregar perde o controle daquela cobrança. O overview não expõe cobrança pendente e não existe rota de retomada/listagem no contrato consultado. Desenhar retomada/reconciliação no módulo antes do checkout real; não guardar confirmação de pagamento no cliente. |
| P1 para distribuição nativa | Sessão e publicação nas lojas | Validar instalação, reabertura, expiração, convite, recuperação, mídias e isolamento em aparelhos; resolver Google nativo e assinar builds conforme [#799](https://github.com/Nocrato-Tech/ageniza/issues/799) e [#820](https://github.com/Nocrato-Tech/ageniza/issues/820). Não bloqueia os testes web autorizados. |
| P2 | Central persistente e push | Ainda não implementados. Definir SPEC de eventos/destinatários/leitura/dispositivos antes de novo módulo. Avisos web locais e e-mails existentes são capacidades diferentes. [#818](https://github.com/Nocrato-Tech/ageniza/issues/818). |

## Machine learning: três implementações diferentes

| Implementação | Evidência | Classificação |
|---|---|---|
| Classificador antigo da demo | `apps/mobile/src/demo/model.ts`: histórico sintético de 96 exemplos, k-NN. O dev publicado mostrou “Risco reduzido de atraso”, “0 de 5 históricos semelhantes” e identificação explícita de dados sintéticos. | Demo funcionando; não é previsão validada. |
| Modelo provisório novo | Árvore local não incorporada: `demo/provisional-model.ts` e `ProvisionalPredictions.tsx`; regressão k-NN com cinco vizinhos, 240 exemplos sintéticos, 192 de treino e 48 reservados; duração global e alcance relativo fictício em sete dias. | Implementado localmente para demonstração; não publicado no SHA observado e sem métricas de eficácia real. |
| Pipeline operacional real | Árvore local não incorporada: `specs/inteligencia-preditiva.md`, módulo API `predictions`, contratos, migrations, job `predictions.capture-and-train` e `ContentPredictions.tsx`. Ridge de duração restante, baseline mediana, splits temporais agrupados e estados explícitos de abstenção. | Implementação local em revisão; não há prova de modelo aprovado, dataset autorizado ou execução no dev. |

O banco local proposto mantém a coleta desligada por padrão (`20261108000900_prediction_collection_opt_in.mjs`). O worker tem rotina periódica e claims com lease; existir código e cron não comprova execução na VPS. POST de treino produz candidato, sem promoção automática. Sem modelo compatível/aprovado ou dados suficientes, a API se abstém.

O alvo social é separado do operacional. A implementação local tem preparação/treino offline, mas serving social não está habilitado: o HTTP informa `not_validated/unsupported_metric`. A integração Instagram exige app Meta, permissões/review, redirect HTTPS, credenciais no servidor e piloto autorizado. Métricas comparáveis e maduras, mesma conta/formato e janela de observação são pré-requisitos; conectar uma conta não cria histórico retrospectivo confiável. Não há garantia de viralização.

A [issue #888](https://github.com/Nocrato-Tech/ageniza/issues/888) permanece aberta e sem respostas: política de promoção, retenção e piloto real. A [resposta de escopo na #817](https://github.com/Nocrato-Tech/ageniza/issues/817#issuecomment-6651058057) autoriza dados sintéticos para a demonstração, mantendo produção futura. As SPECs locais avançaram em relação ao texto histórico da issue; nenhuma delas deve ser confundida com um deployment.

## Cloud e hospedagem

A hospedagem não está ausente. A arquitetura existente usa VPS Hostinger, Docker, PostgreSQL próprio, Cloudflare Tunnel e GitHub Actions, com isolamento dev/produção descrito em [ADR 0013](../adr/0013-dev-environment-on-the-vps.md). O dev está acessível e os preços/cotação foram consultados em sessão autenticada.

| Comprovado nesta sessão | Ainda precisa de evidência |
|---|---|
| HTML/bundle da aplicação acessíveis, versão pública e saúde API; consultas autenticadas e cotação/recusa simulada. | Processos/jobs individuais saudáveis, migrations V2 aplicadas, captura real, storage multipart e transcodificação ponta a ponta, SMTP de produção, limites do host, alarmes, recuperação e rollback. |

Dev usa Mailpit e dados fictícios, sem backup por decisão existente. Isso não é defeito a corrigir copiando dados reais para dev. Produção precisa de backup restaurável antes de receber dados reais. Seguir [prontidão de produção](../infra/production-readiness.md), [backup/restauração](../infra/backup-restore.md) e [deploy/rollback](../infra/production-deploy.md). Não foi feita inspeção SSH nem se presumiu que itens antigos não marcados em documentação continuem ausentes no servidor.

Para hospedar o ML operacional proposto, primeiro validar o job e sua demanda no worker/PostgreSQL existentes; não há evidência nesta auditoria que justifique exigir GPU ou migrar toda a hospedagem.

## Planos e pagamentos

Os planos e regras já estão definidos em [#770](https://github.com/Nocrato-Tech/ageniza/issues/770) e nas decisões de 29/10: preços provisórios no banco, três planos mensais, extras por unidade, colaboradores/portal ilimitados nos pagos, upgrade proporcional, downgrade no próximo período sem ficar abaixo do uso, cancelamento e tolerância. O PR visual não altera esses termos.

| Caminho | Evidência e limite |
|---|---|
| Consulta de plano/uso | GET de agência, overview e catálogo carregaram no dev; trial até 20/11 e preços 97/197/397 mensais. |
| Seleção e cotação | Essencial sem extras retornou R$ 97,00 pelo servidor. A revisão apareceu antes da cobrança. |
| Criação e recusa fictícia | Ação explícita criou cobrança pendente no dev; recusa retornou mensagem do servidor e manteve teste grátis. Nenhum dinheiro movimentado. |
| Aprovação fictícia | Coberta por testes UI com respostas controladas, incluindo resposta divergente e clique duplicado. Não foi executada nesta sessão contra o dev. |
| Cancelar/reativar e redução | Rotas, estados e worker existentes; tela conserva ações. Testes UI cobrem período, tolerância e redução pendente. Não foram exercitados end-to-end no servidor nesta auditoria. |
| Checkout real/retorno/webhook | Ainda não implementado o adaptador real. `packages/payments` possui porta e somente adaptador simulado; configurar `asaas` na UI não implementa o provedor. |
| Retomada após sair da tela | Lacuna de produto/contrato identificada acima: cobrança pendente não é recuperada pelo overview. |

A simulação do dev é intencional, conforme [resposta na #819](https://github.com/Nocrato-Tech/ageniza/issues/819#issuecomment-6651058260). A [resposta do mantenedor na #785](https://github.com/Nocrato-Tech/ageniza/issues/785#issuecomment-6508408089) identifica duas dependências do adaptador real: chave/tentativa após recusa e conciliação de estornos com falha. O worker de renovação já existe (`renew-subscriptions-job.ts`, integrado por #790); um README antigo que diz “PR seguinte” não comprova ausência atual.

### Reformulação implementada

- Comparação em linhas selecionáveis, sem cartões independentes e sem seletor duplicado. Nome, capacidade, valor mensal e plano atual ficam no mesmo lugar.
- Extras mostram preço unitário lido do catálogo e total mensal estimado, sem substituir cotação/pro rata do servidor.
- Seleção/campos ficam bloqueados enquanto a requisição está em andamento, evitando revisão de uma escolha diferente da exibida. Editar depois invalida a cotação/revisão anterior.
- Simulação ou indisponibilidade do pagamento ficam explícitas antes da ação. Carregamento, erro com tentativa, sucesso, cobrança pendente e recusa conservam os contratos existentes.
- Seleção com semântica radio, setas/Home/End, foco preservado e `aria-checked`. Transição somente de opacidade, 180 ms com token existente, interrompível, imediata por teclado/movimento reduzido. Nenhum remount da página a cada escolha.

## Inventário do restante do app

“Implementado” abaixo descreve código e contratos existentes; a coluna de evidência limita o que foi comprovado. Não é aceite integral de módulo.

| Área | Estado | Evidência / o que falta comprovar |
|---|---|---|
| Login/contexto | Implementado; sessão web operante | Navegador já estava autenticado e consultou dados da agência. Novo login/logout e persistência física não executados. |
| Cadastro, confirmação, convite e recuperação | Implementado, validação ponta a ponta pendente nesta sessão | `EntryScreen`, links/contratos e testes; conferir caixa dev e expiração dos links sem encerrar a sessão do usuário para esta auditoria. Google nativo continua #799. |
| Clientes/cadastro | Implementado; leitura real funcionando | Carteira com dois clientes, formulário, resumo, portal e ações de encerramento carregaram. Não arquivado nem alterado cadastro. |
| Marca/personas | Implementado; leitura real funcionando | Sete seções, paleta e editores apareceram. Gravação/retorno portal não exercitados nesta sessão. |
| Lista/kanban/calendário | Implementado; lista e calendário funcionando na leitura real | Conteúdos e contagens por data/status apareceram; navegação preservou seleção. Testes cobrem período/teclado. |
| Conteúdo e mídias | Implementado; detalhe real funcionando | Conteúdo/revisão/mídia vinculada carregaram. Upload multipart, recuperação de URL e vídeo/transcodificação não testados end-to-end. |
| Tarefas | Implementado; leitura real funcionando | Tarefa aprovada e controles apareceram no detalhe. Edição/devolução reais não executadas. |
| Aprovação, retirada e ajuste | Implementado; transições reais não exercitadas nesta sessão | Conteúdo em aprovação, aprovação externa e estado aguardando cliente renderizaram; contratos e testes de permissão existem. Portal/link sem conta precisam validação própria com conta/contexto autorizado. |
| Comentários | Implementado; consulta/compositor real funcionando | Aba de conversa carregou vazio e campo de comentário. Nenhuma mensagem foi enviada. Não inferir envio por haver compositor. |
| Equipe | Implementado; validação real de mutações pendente | `TeamScreen`, contratos e testes de papéis/convites. Não foram enviados convites nem alteradas pessoas. |
| Relatórios/CSV | Implementado; agregados reais funcionando | Resumo mensal, etapas e faixas de dias renderizaram. São métricas editoriais, não insights Instagram. Exportação coberta pelos testes, não baixada nesta sessão. |
| Notificações | Atividades e aviso local implementados; push/central persistente ausentes | Tela real avisa que leitura é só da sessão e que não há push remoto. E-mails de aprovação/publicação existentes não dependem dessa central. |
| Perfil/conta | Implementado; fluxo real não reexecutado | `ProfileScreen`, API e testes; foto/troca de e-mail/sessões exigem comprovação própria. |
| Instagram | Implementação local; configuração/piloto pendentes | Módulo, pacote, contratos, migrations e worker ainda fora do PR visual; sem conexão/publicação real comprovada. |

## Validação e artefatos

Na árvore original com alterações locais, suíte mobile: 337 testes em 64 arquivos aprovados; lint e tipos aprovados. Na base isolada do PR, 321 testes em 62 arquivos aprovados, tipos e lint aprovados, exportação Android/iOS/web aprovada. Os contratos foram recompilados nessa base. As dependências locais compartilhadas exigiram configuração temporária de acesso às duas pastas no Vitest/Metro; ela não integra o produto nem o PR. A validação local usou Node 24 disponível no executor; o CI com Node 22/pnpm 9 permanece a confirmação do ambiente canônico.

Revisão independente de outro modelo: quatro testes existentes e cinco ataques adicionais aprovados, incluindo revisão inválida após editar, seleção por teclado, cotação sem provedor, duplicação/edição durante requisição e extras acima do contrato. Nenhum achado concreto no diff de planos. A revisão não valida autorização/RLS do servidor, provedor real ou execução física. As falhas iniciais de resolução de dependências/tipos na worktree foram resolvidas pelo autor antes da validação final acima.

Inspeção local em 390×844 e desktop: comparação, preços/extras, revisão, seleção rápida e teclado; erro de carregamento com ação de atualizar; console sem erros observados na captura normal. Screenshots em `outputs/mobile-plans-readiness/`: `plans-mobile.jpg`, `plans-desktop.jpg`, `plans-error.jpg` e `published-ml.jpg`. São artefatos locais fora do repositório de aplicação. O harness visual usa os componentes reais e respostas controladas, identificado em faixa visível, e não é publicado como outro aplicativo.

Limitações: sem ensaio de desempenho em aparelho físico, sem teste real de pagamento, sem métricas reais de ML, sem auditoria operacional da VPS e sem aceite global de todos os fluxos. Nenhuma dessas limitações se resolve declarando um percentual de conclusão.

## Integração aprovada posteriormente em 16/11
O novo modelo provisório passa a integrar o detalhe de conteúdo do aplicativo oficial neste PR. Não fica restrito ao harness de prévia. Agência fictícia vê cenários e histórico sintético; os dois clientes de exemplo veem cenário sanitizado sem sinais internos. Continua exclusivo da demonstração web dev. O pipeline operacional real e Instagram permanecem fora desta entrega. O web foi conferido na base 2a1148bb: sua assinatura já usa os novos componentes subscription-compare/plans/payment e contratos atuais; esses arquivos foram preservados.
