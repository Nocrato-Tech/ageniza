# Demonstração no app autenticado com dados sintéticos

**Validação.** Pendente de validação do dono.

## Contexto

Em 05/11/2026, Marcos corrigiu explicitamente a interpretação da entrega: quer o aplicativo oficial completo, com login, cadastro, interações e endpoints reais. Somente os dados são fictícios. A apresentação pública separada de três abas não atende. A autorização anterior para ML sintético, cobrança simulada e iOS web continua válida.

## Decisão

A demonstração usa a mesma entrada e as mesmas telas do app mobile. Sessão, confirmação de e-mail, termos, contextos, permissões e persistência são os do servidor. Não há login falso nem fallback para repositório local.

No ambiente dev, uma pessoa autenticada que pode criar agência pode criar uma agência própria com exemplos sintéticos pelas rotas existentes. A preparação escreve apenas nessa nova agência, tem progresso e permite retomar falhas parciais. Não cria colaboradores ou acessos de portal automaticamente nem envia convites para pessoas fictícias. Essas interações continuam disponíveis nas telas oficiais com destinatários informados pelo usuário.

A assinatura usa o provedor simulado já oferecido pela API dev; confirmação, recusa, cancelamento e reativação são persistidos no servidor. ML com histórico sintético é uma função no detalhe do conteúdo; os sinais vêm do conteúdo carregado. Avisos são locais no navegador e acionados explicitamente.

## Consequências

A origem autorizada é `dev.ageniza.com.br/app-mobile/`. Publicação depende do processo existente de revisão independente e deploy de develop, sem enfraquecer origem, cookies, CSRF ou proteção do inbox. Não há alteração estrutural, de tabelas, RLS, permissões ou respostas. A decisão registra a correção em relação à alternativa da apresentação independente; o registro anterior permanece histórico.

Issue: #833.
