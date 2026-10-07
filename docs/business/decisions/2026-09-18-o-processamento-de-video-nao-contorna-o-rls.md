# O processamento de vídeo não contorna o RLS
**Data.** 2026-09-18

**Contexto.** O worker precisa ler e gravar dados de uma agência sem haver requisição de usuário.

**Decisão.** O worker autentica a transação como o usuário que confirmou o upload, em vez de usar uma identidade de serviço com acesso irrestrito.

**Consequência.** Se a permissão dessa pessoa for revogada entre o upload e o processamento, o job vira no-op silencioso e **o arquivo fica sem thumbnail e sem preview indefinidamente**, sem sinal para a operação. Preserva o invariante de que a aplicação nunca contorna o RLS.

**Origem.** PR #40. **Pendente de validação.**

