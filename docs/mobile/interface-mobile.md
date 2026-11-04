# Interface mobile — reconstrução a partir do Figma

O cliente Expo em `apps/mobile` usa as telas aprovadas de [Ageniza · Mobile UI](https://www.figma.com/design/GysDnvGjqZlledBVlnS5pW). A instrução do designer de 03/11/2026 substitui a direção visual inicial do cliente mobile: tema claro, Sora/Inter, cards, seleção de clientes em stories e navegação inferior. Nenhuma regra, token ou tela da aplicação web foi alterada.

## Referências implementadas

| Fluxo | Artboards de referência | Implementação |
|---|---|---|
| Início e clientes | `7:4`, `7:137`, `7:301` | resumo calculado, busca, seleção de cliente e carteira |
| Conteúdos e kanban | `7:404`, `36:572` | lista, filtros, quadro horizontal, detalhe e tarefas |
| Criação e edição | `8:364`, `37:829`, `37:1007` | formato → conteúdo/mídia → prévia; salvar e enviar são operações distintas |
| Calendário | `36:761` | meses e dias selecionáveis, publicações do dia |
| Mídias | `36:975`, `36:1142` | pastas, filtros, seleção, upload, imagem e reprodução de vídeo |
| Portal e aprovação | `38:1154`, `38:1229`, `38:1300` | feed por datas, aprovações, revisão, pedido de ajuste e comentários |
| Equipe | `8:424`, `8:542` | lista, busca, perfil e conteúdos sob responsabilidade |
| Gestão | `10:407`, `10:538`, `10:659`, `10:787` | resumo por período, CSV, menus, nome do perfil e atividades locais |
| Experimento de ML | `138:4687`, `138:5072` | k-NN local com exemplos sintéticos; não é previsão validada ou módulo da API |

As continuações das artboards são conteúdo rolável, não telas truncadas. O kanban deixa parte da próxima coluna visível; o portal não mostra kanban, stories de clientes, responsável ou tarefas internas.

## Dois modos, sem fallback entre eles

**API real:** contexto autenticado no Expo Go. Usa as rotas documentadas de clientes, conteúdos, mídia, tarefas, conversas, equipe e perfil, com os contratos de `@ageniza/contracts`. O servidor decide permissões, leitura, revisão e transições. Não existe sessão de demonstração enviada à API. Sessões e cookies ficam no transporte nativo, com SecureStore.

**Demonstração:** armazenamento local versionado, sem credenciais e sem chamada à API. Criação, edição, mídia, tarefas, comentários, aprovação e ajustes compartilham o mesmo conjunto de dados. As alterações persistem ao recarregar; há ação explícita de reiniciar os dados. No navegador, um arquivo de teste é armazenado como data URL e há limite de 8 MB, sujeito à cota do navegador. No aparelho, a seleção de arquivo usa o cache do Expo e não deve ser tratada como backup durável.

O relatório calcula contagens a partir dos conteúdos do período e exporta CSV; não inventa indicador de pontualidade sem histórico. A API ainda não oferece notificações push ou previsão de atrasos. A central da demonstração lista atividades das operações de teste. O experimento de ML mostra a limitação dos dados sintéticos e nunca altera prazo ou responsável automaticamente.

## Conexão e verificação

Em 03/11/2026, a origem nativa `ageniza://` foi liberada no dev pelo responsável do servidor, conforme [#803](https://github.com/Nocrato-Tech/ageniza/issues/803#issuecomment-6613231931). A conferência sem credenciais retornou `400 VALIDATION_ERROR` em `POST /api/auth/login` com corpo vazio. Isso prova a aceitação da origem, não um login autenticado. `exp://` continua proibido, e Google permanece dependente da #799.

A liberação nativa não autoriza a origem web da Vercel. Essa publicação continua em demonstração; não há proxy para contornar cookies, CORS ou CSRF.

O app foi alinhado ao `develop` com `@better-auth/expo` 1.7.7, conforme a revisão do #804 e a #805. O transporte nativo usa `expo/fetch`, recusa redirecionamento e origem final divergente antes de persistir cookies e envia POST sem conteúdo como corpo de zero bytes, evitando o byte nulo do fallback Android. Falhas de escrita não envenenam a fila de armazenamento; logout tenta revogar no servidor e sempre bloqueia/limpa o acesso local. Falha na exclusão segura mantém o acesso bloqueado em memória e informa que o armazenamento precisa ser apagado antes de compartilhar o aparelho. O 401 de credenciais inválidas não apaga uma sessão existente. Erros de restauração oferecem nova tentativa, e mudanças de termos/e-mail retornam à resolução de entrada.

As mutações executadas na rodada atual foram detectadas pelos testes: prefixo de cookie incorreto com o codec real, remoção da guarda de origem final, rejeição persistente na fila de escrita, ausência de expiração ao falhar a exclusão, limpeza indevida no 401 do login, ausência de transição por política de acesso, POST nativo sem corpo explícito e logout local dependente da rede. Os arquivos foram restaurados após cada mutação.

Typecheck, lint, testes de estado/persistência/contratos e exportação Android/iOS/web compõem a verificação automatizada. A conferência pelo navegador cobre tarefas → envio → pedido de ajuste → edição → reenvio → aprovação da revisão 2, criação em três etapas e persistência ao recarregar. Teste com conta no aparelho, reabertura, cookie real `__Secure-`, troca de contexto e logout ainda precisam de evidência física antes de afirmar validação nativa completa. A revisão de segurança independente continua necessária antes do merge.
