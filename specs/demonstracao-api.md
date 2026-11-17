# Demonstração ao vivo da API

## Propósito
Na P2, demonstrar a API já implementada com respostas reais do ambiente acessado, dentro da referência existente `/mobile/api`. Sem nova área de produto ou novo módulo de backend.

## Escopo e acesso
A página continua limitada ao build de documentação dev existente. Consultas públicas GET fixas: `/health`, `/ready`, `/auth/providers`. O usuário executa explicitamente; mostra URL configurada, HTTP, duração, horário e corpo recebido. Não envia cookies, credenciais ou corpo, não segue redirecionamentos e não permite digitar destinos. Rotas protegidas conservam sessão e permissões normais.

## Estados
Sem consulta, consultando, resposta HTTP (inclusive erro do servidor), falha de rede/tempo limite e nova tentativa. A nova consulta limpa a resposta anterior; nenhuma falha é substituída por exemplo. Desmontar cancela a consulta. Sem polling ou armazenamento de respostas.

## Verificação
GET real após clique, ausência de requisição automática/credenciais, HTTP de falha preservado, nova tentativa, bloqueio de sobreposição e cancelamento. Gate de produção da referência já existente permanece coberto pelos testes de build/rota.
