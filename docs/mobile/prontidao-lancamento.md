# Prontidão do aplicativo para lançamento

O objetivo é entregar o aplicativo completo para uso real. Uma demonstração, exportação JavaScript ou publicação web não comprova prontidão nativa.

## Implementado nesta etapa, ainda sem validação física

- Entrada exclusivamente pelo login e contexto autenticado, sem acesso a demonstração.
- Cadastro, consentimento, confirmação e reenvio de e-mail, recuperação e redefinição de senha.
- Convites com conta nova ou existente; resolução do contexto do convite pelo servidor.
- Criação de agência e seleção de contexto conforme os contratos existentes.
- Gestão de cadastro, encerramento, arquivamento e reativação de clientes.
- Estudo de marca, cores, arquétipo, personas e conversas por assunto.
- Acessos ao portal, reenvio de boas-vindas, remoção e reativação.
- Equipe, convites, cargos, papéis, remoção e reativação.
- Roteiros de stories: criação, edição, ordenação de cenas, envio e registro de gravação no portal.
- Edição e devolução de tarefas; aprovação recebida fora da plataforma; cancelamento, reagendamento e desfazer publicação.
- Perfil, foto, solicitação de troca de e-mail e encerramento de sessões.
- Consulta de assinatura, cotação sem cobrança e ações de cancelamento/reativação.
- Vídeo original, recuperação de mídia expirada e biblioteca carregada por cliente.

As ações continuam sujeitas às permissões, estados e limites da API. Formulários compilarem não significa que todos os caminhos foram exercitados no servidor.

## Evidências existentes

Na última rodada de verificação:

- Typecheck e lint de todo o monorepo passaram (18 e 11 tarefas, respectivamente).
- `pnpm test` concluiu as 18 tarefas do monorepo sem falhas; a suíte web registrou 2.539 testes aprovados.
- 80 testes passaram em 14 arquivos antes da configuração de subpasta; a rodada integrada de CI também inclui o sexto teste de configuração, incluindo formulários renderizados por React Native Web, consentimento, credenciais, convite, contexto, permissões, leitura e alvo de remoção.
- A instalação com lockfile congelado passou após encerrar o Metro que mantinha arquivos de dependências ocupados no Windows.

A configuração Expo em `app.config.js` passou pelos testes e pela exportação Android/iOS/web. As dependências passaram pela verificação de compatibilidade do Expo; os dois testes de isolamento dos peers nativos também passaram.

## Trabalho que continua pendente

| Área | Próxima comprovação necessária |
|---|---|
| Alterações locais | PRs #809 (entrada), #810 (operações), #811 (build), #812 (aprovação por e-mail) e #813 (foto do cliente e verificações) abertos como rascunho e enviados para revisão, empilhados sobre #804. |
| Mutações | Mutações executadas e detectadas: origem estrangeira, consentimento do convite, e-mail convidado, escrita no portal em modo leitura, alvo de remoção, escopo da sessão de aprovação e revisão enviada. Arquivos restaurados. O rigor completo de todos os novos aceites ainda não foi concluído. |
| Exportação | Exportação Android/iOS/web passou incluindo o fluxo de aprovação por e-mail. A foto do cliente foi acrescentada depois dessa exportação e é verificada pela compilação Android seguinte. |
| Android | Validar o workflow de APK interno e executar o artefato em aparelho físico. O workflow foi publicado e a execução 41763507734 gerou o APK de 8acb061d. O arquivo foi baixado e conferido: pacote com.ageniza.mobile.internal, bundle JavaScript embutido, API dev e bibliotecas nativas. SHA-256: 287534f20bdfef041bf12ecd33dd0196b0fd8c04df0b67762080454478703904. Isso não comprova execução física. |
| Sessão | Login real, persistência após fechar/reabrir, troca de contexto, expiração e logout no aparelho. |
| Contas | Exercitar cadastro, confirmação, convite e recuperação com a caixa de e-mail do dev. |
| Mídias | Upload simples e multipart no armazenamento real; reprodução, miniaturas, expiração e recusa de remoção em uso. |
| Permissões | Exercitar os papéis reais e isolamento entre duas agências; testes de interface não substituem testes de isolamento no servidor. |
| Aprovação sem conta | Integração nativa implementada com cookie próprio mantido só em memória, restrito ao lote e separado do login. Testes unitários e de interface passaram; validação física e revisão independente pendentes. |
| Google | Resolver a issue #799 antes de habilitar login nativo em produção. |
| Machine learning | O experimento sintético foi retirado da interface real. Faltam especificação aprovada, histórico real, avaliação e integração de produção. |
| Notificações | A lista atual deriva dos conteúdos carregados. Não há central persistente nem push de produção. |
| Pagamento | A cotação existe; contratação e pagamento real ainda dependem da integração de produção. Não apresentar pagamento simulado como concluído. |
| Navegação externa | Interpretar um caminho `ageniza://` não configura Universal Links/App Links nem altera o destino dos e-mails. |
| Revisão | Código e revisão independente de segurança antes de merge, conforme as instruções do repositório. |
| Publicação | Projeto de build, assinatura de produção, distribuição iOS/Android, configuração da API de produção e checklist operacional. |

## Situação de execução

A API dev respondeu 200 no health. Isso não comprova login autenticado ou fluxo físico.

A Vercel publica a interface web real e mantém o APK em https://mobile-vercel-preview.vercel.app/downloads/ageniza-android.apk, substituindo a demonstração web. O APK de a456d4a1 inclui o fluxo de aprovação por e-mail; o workflow 41764475323 concluiu com sucesso. SHA-256: d898cab81ade83b294be3c87c81424fc1331ee9c5d46824f8d3ffffd1352d1a7. A compilação 41765497119 concluiu com sucesso e gerou o APK 59000fb2 com a foto do cliente (70.775.541 bytes; SHA-256: 05d10a207c3366bf665701aedbe9776ab03b2418caf17874b9e774004d50b45e). O bundle JavaScript, o destino da API, a rota de aprovação e o identificador do pacote foram conferidos no APK. O arquivo utiliza assinatura de desenvolvimento e API dev; não é uma publicação nas lojas nem comprovação de execução física.

O checklist operacional do sistema continua em [prontidão de produção](../infra/production-readiness.md).


## Entrega para revisão — 04/11/2026

A [issue #821](https://github.com/Nocrato-Tech/ageniza/issues/821) reúne a ordem de aprovação dos PRs #804, #809, #810, #811, #812, #813, #815 e #816 e as dependências #799, #814 e #817–#820. A revisão foi solicitada ao responsável; não há aprovação do autor nem merge automático.

O PR #815 corrige criação parcial: depois de receber o ID da API, uma falha posterior não faz o próximo salvamento criar outro conteúdo. Acrescenta testes de foto para leitor, cancelamento, limite, alvo, confirmação e erro após gravação. Quatro mutações executadas ficaram vermelhas e os arquivos foram restaurados: remover a entrega antecipada do ID, perder o ID no editor, expor alteração de foto ao leitor e trocar o endpoint da foto.

O workflow [41770722090](https://github.com/Nocrato-Tech/ageniza/actions/runs/41770722090) passou: tipos, lint, testes mobile, exportação Android/iOS/web e smoke tests reais das imagens dev/produção. A imagem dev serviu HTML e bundle em `/app-mobile/`; assets inexistentes retornaram 404; a imagem de produção não publicou a interface. O primeiro smoke test tinha uma corrida de inicialização do Nginx; a nova execução espera o serviço e mantém as verificações.

A hospedagem de mesma origem ainda precisa de revisão e deploy no dev. Não houve teste autenticado nem físico. O APK público continua no commit 59000fb2 e não inclui #815/#816. Revisar os commits atuais da pilha; nenhum módulo pendente de produto passa a estar implementado por ter sido registrado como issue.
