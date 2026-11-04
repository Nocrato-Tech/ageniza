# Prontidão do aplicativo para lançamento

O objetivo é entregar o aplicativo completo para uso real. Uma demonstração, exportação JavaScript ou publicação web não comprova prontidão nativa.

## Implementado nesta etapa, ainda sem validação física

- Entrada pelo login; demonstração somente por escolha explícita.
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

Na última rodada executada antes da interrupção:

- Typecheck e lint do mobile passaram.
- 69 testes passaram em 12 arquivos, incluindo formulários renderizados por React Native Web, consentimento, credenciais, convite, contexto, permissões, leitura e alvo de remoção.
- A instalação com lockfile congelado passou após encerrar o Metro que mantinha arquivos de dependências ocupados no Windows.

Depois dessa rodada, o arquivo de configuração Expo foi renomeado de `app.config.cjs` para `app.config.js`, com ajuste do teste correspondente. Essa alteração ainda precisa de nova verificação.

## Trabalho que continua pendente

| Área | Próxima comprovação necessária |
|---|---|
| Alterações locais | Separar commits e PRs por tema, sem ultrapassar o escopo revisável; existem arquivos novos e modificados ainda sem commit. |
| Mutações | Executar as mutações dos novos aceites e restaurar cada arquivo; a tentativa de iniciar essa bateria não chegou a executar. |
| Exportação | Repetir exportação Android, iOS e web com a implementação atual. |
| Android | Validar o workflow de APK interno e executar o artefato em aparelho físico. O workflow foi escrito, mas não foi publicado nem executado. |
| Sessão | Login real, persistência após fechar/reabrir, troca de contexto, expiração e logout no aparelho. |
| Contas | Exercitar cadastro, confirmação, convite e recuperação com a caixa de e-mail do dev. |
| Mídias | Upload simples e multipart no armazenamento real; reprodução, miniaturas, expiração e recusa de remoção em uso. |
| Permissões | Exercitar os papéis reais e isolamento entre duas agências; testes de interface não substituem testes de isolamento no servidor. |
| Aprovação sem conta | O link de lote usa cookie próprio; ainda falta integração nativa separada da sessão de login. |
| Google | Resolver a issue #799 antes de habilitar login nativo em produção. |
| Machine learning | O k-NN atual usa exemplos sintéticos. Faltam especificação aprovada, histórico real, avaliação e integração de produção. |
| Notificações | A lista atual deriva dos conteúdos carregados. Não há central persistente nem push de produção. |
| Pagamento | A cotação existe; contratação e pagamento real ainda dependem da integração de produção. Não apresentar pagamento simulado como concluído. |
| Navegação externa | Interpretar um caminho `ageniza://` não configura Universal Links/App Links nem altera o destino dos e-mails. |
| Revisão | Código e revisão independente de segurança antes de merge, conforme as instruções do repositório. |
| Publicação | Projeto de build, assinatura de produção, distribuição iOS/Android, configuração da API de produção e checklist operacional. |

## Interrupção de execução

A revisão automática de permissões não pôde avaliar o comando que prepararia e executaria as mutações porque a conta atingiu o limite de uso. O comando não foi executado; isso não representa reprovação de segurança do código. Não houve tentativa de contornar o bloqueio por outro mecanismo.

O Metro na porta 8095 foi encerrado durante a instalação de dependências e ainda não foi reiniciado. O endereço público da Vercel continua na versão publicada anteriormente; as funcionalidades desta etapa permanecem locais até concluir as verificações e a publicação.

O checklist operacional do sistema continua em [prontidão de produção](../infra/production-readiness.md).
