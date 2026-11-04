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

Na última rodada executada antes da interrupção:

- Typecheck e lint do mobile passaram.
- 73 testes passaram em 13 arquivos, incluindo formulários renderizados por React Native Web, consentimento, credenciais, convite, contexto, permissões, leitura e alvo de remoção.
- A instalação com lockfile congelado passou após encerrar o Metro que mantinha arquivos de dependências ocupados no Windows.

A configuração Expo em `app.config.js` passou pelos testes e pela exportação Android/iOS/web. As dependências passaram pela verificação de compatibilidade do Expo; os dois testes de isolamento dos peers nativos também passaram.

## Trabalho que continua pendente

| Área | Próxima comprovação necessária |
|---|---|
| Alterações locais | PRs #809 (entrada), #810 (operações) e #811 (build) abertos como rascunho e enviados para revisão, empilhados sobre #804. |
| Mutações | Mutações executadas e detectadas: origem estrangeira, consentimento do convite, e-mail convidado, escrita no portal em modo leitura, alvo de remoção, escopo da sessão de aprovação e revisão enviada. Arquivos restaurados. O rigor completo de todos os novos aceites ainda não foi concluído. |
| Exportação | Exportação Android/iOS/web passou antes do novo fluxo de aprovação por e-mail; repetir para esse fluxo. |
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

O bloqueio temporário da revisão automática não se repetiu nesta sessão: comandos, mutações, push e solicitação de revisão puderam ser executados. A API dev respondeu 200 no health. Isso não comprova login autenticado ou fluxo físico.

O endereço público da Vercel continua na versão anterior e não deve ser apresentado como o aplicativo completo. O primeiro resultado instalável é o APK do workflow 41763507734, disponível nos artefatos privados do GitHub. O fluxo de aprovação por e-mail foi acrescentado depois do início dessa primeira compilação e precisa entrar na compilação seguinte.

O checklist operacional do sistema continua em [prontidão de produção](../infra/production-readiness.md).
