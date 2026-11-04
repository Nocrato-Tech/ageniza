# Interface mobile — implementação a partir do Figma

O cliente React Native/Expo está em `apps/mobile` e segue as telas aprovadas de [Ageniza · Mobile UI](https://www.figma.com/design/GysDnvGjqZlledBVlnS5pW): tema claro, Sora/Inter, cards, seleção de clientes em stories e navegação inferior. A direção do designer substitui a prévia inicial. Não altera regras de negócio do servidor.

## Telas e integração

| Fluxo | Artboards de referência | Implementação atual |
|---|---|---|
| Início e clientes | `7:4`, `7:137`, `7:301` | resumo do período, busca, seleção e carteira; cadastro, marca, personas, acessos e ciclo de vida usam a API |
| Conteúdos e kanban | `7:404`, `36:572` | lista, filtros, quadro horizontal, detalhe, tarefas e transições do contrato |
| Criação e edição | `8:364`, `37:829`, `37:1007` | formato → conteúdo/mídia → prévia; salvar e enviar são operações distintas; criação parcial preserva o ID recebido |
| Calendário | `36:761` | meses e dias selecionáveis, publicações do dia |
| Mídias | `36:975`, `36:1142` | pastas e subpastas, filtros, upload simples/multipart, imagem e vídeo real |
| Portal e aprovação | `38:1154`, `38:1229`, `38:1300` | feed por datas, aprovar/pedir ajuste, revisão e comentários; aprovação por e-mail usa sessão separada |
| Equipe | `8:424`, `8:542` | lista, busca, convites, papéis, cargo, remoção e reativação conforme permissão |
| Gestão | `10:407`, `10:538`, `10:659`, `10:787` | relatório do período e CSV, perfil, consulta de assinatura, cotação e cancelamento/reativação |
| Machine learning | `138:4687`, `138:5072` | não implementado em produção; #817 registra a especificação e avaliação necessárias |

As continuações das artboards são conteúdo rolável. O quadro deixa parte da próxima coluna visível. O portal não mostra kanban, seleção de stories de clientes, responsável ou tarefas internas. Roteiros de stories seguem as permissões e estados do servidor.

## Dados e sessão

A entrada exige conta e contexto real. `MobileApp` usa somente o adaptador da API, sem fallback para dados locais. O teste `real-entry.test.ts` percorre a árvore de imports e barra o repositório demonstrativo e o modelo sintético no app. Os arquivos de demonstração restantes são fixtures de teste, não uma opção de entrada.

Os contratos vêm de `@ageniza/contracts`. O servidor decide permissões, leitura, revisão e transições. O relatório conta conteúdos efetivamente retornados; não inventa engajamento ou pontualidade. A lista de atividades deriva do período carregado e sua marcação de leitura não é persistente; central/push de produção seguem #818. Cotação não significa pagamento; produção segue #819.

No nativo, `expo/fetch` envia `expo-origin: ageniza://`; o cookie é guardado em SecureStore. O transporte recusa redirecionamentos e origem final divergente antes de persistir cookies. Escritas rejeitadas não envenenam a fila. Logout tenta revogar no servidor e bloqueia o acesso local mesmo sem rede; falha de exclusão segura é informada. O 401 do login não apaga outra sessão válida. Mudanças de termos/e-mail retornam à resolução de entrada.

Links de conta aceitam somente origem/caminhos autorizados. A aprovação por e-mail mantém `ageniza_approval` apenas em memória, restrita ao lote e separada da sessão de login. Abrir não aprova: a decisão usa `canDecide` e a revisão lida.

## Publicação

A origem nativa `ageniza://` foi liberada no dev em #803. A conferência sem credenciais retorna `400 VALIDATION_ERROR` no login vazio; não prova um login autenticado. `exp://` não foi liberado. Google segue #799.

A Vercel publica a interface real, mas seu domínio não está autorizado para sessões web. O PR #816 prepara a interface em `/app-mobile/` na imagem web de desenvolvimento, na mesma origem da API. O prefixo de assets é exportado pelo Expo; arquivos inexistentes respondem 404. Não altera CORS, CSRF, SameSite ou trusted origins. A URL só existe no servidor depois de revisão, merge e deploy; a imagem de produção não inclui essa exportação.

O APK interno está disponível no link registrado em [prontidão de lançamento](prontidao-lancamento.md). É assinado para uso interno e aponta ao dev. iOS assinado/TestFlight, identidade de produção e validação em aparelho seguem #820. Exportação JavaScript não comprova execução nativa.

## Movimento e verificação

A interface usa Animated do React Native: resposta ao toque, entrada curta de telas e painéis. A preferência de reduzir movimento remove deslocamentos e animações; nenhuma animação atrasa requisições ou altera regras.

Os testes cobrem contratos, persistência/expiração de sessão, convites, restrições do portal, revisão de aprovação, alvo de foto e recuperação de criação parcial. O workflow `Mobile review` verifica tipos, lint, testes, exportações Android/iOS/web e imagens web dev/produção. Resultados, mutações e limitações estão nos PRs e na [issue central #821](https://github.com/Nocrato-Tech/ageniza/issues/821). A revisão independente de segurança continua necessária; nenhum teste local é aprovação do autor.
