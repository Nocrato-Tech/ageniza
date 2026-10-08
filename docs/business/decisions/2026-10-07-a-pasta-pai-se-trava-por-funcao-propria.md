# A pasta pai se trava por uma função própria

**Data.** 2026-10-07

**Contexto.** Uma rota de pastas ou de mídia que precise serializar sobre a pasta pai faria `select ... for update` como `ageniza_app`. Na pasta padrão isso devolve **zero linhas** e não trava nada: a policy de `UPDATE` de `media_folders` exclui `is_default` (requisito da revisão do PR #376, #253). A trava do cliente nas inserções (pasta e mídia nascendo enquanto o cliente é arquivado) é outro assunto: vem do gatilho `AFTER INSERT` da migration 20261007001400.

**Decisão.**
1. `app_private.lock_media_folder(pasta)`, `security definer`, confere `conteudo.operar` e `conteudo.visualizar` antes de travar, responde `A0080` ("não encontrada") a quem não os tem e à pasta que não existe ou é de outra agência, e devolve a linha travada.
2. A trava é `FOR UPDATE`, não `FOR NO KEY UPDATE`: a inserção de uma pasta filha ou de uma mídia na pasta toma `KEY SHARE` no pai pela chave estrangeira, e só `FOR UPDATE` a faz esperar.
3. A função não olha se o cliente está arquivado: isso é do gatilho do cliente.

**Consequência.** A rota que precisar serializar chama a função na primeira instrução que toca a pasta, no mesmo molde de `lock_content_for_agency`. Não é estrutural.

**Origem.** Issue #253, requisito da revisão do PR #376.

**Validação.** Pendente de validação do dono.
