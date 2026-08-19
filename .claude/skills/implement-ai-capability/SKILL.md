---
name: implement-ai-capability
description: Implement an AI capability end to end in the intelligence module — tools over domain services, versioned prompt, AiRun with cost, AiProposal for external actions, evals, and UI as signals/insights.
---

# implement-ai-capability

Referências: `docs/AI_ARCHITECTURE.md` (contrato da capacidade em §3), `docs/DESIGN_DIRECTION.md §6`. Executar com o agente `intelligence`.

## Passos

1. **Contrato da capacidade**: entrada, saída estruturada (schema Zod), gatilho (evento/job/pedido) e se propõe ação externa. Registre/atualize em `docs/AI_ARCHITECTURE.md §3`.
2. **Determinístico primeiro**: que parte dá para calcular sem LLM (recência, valores, movimentação)? Sinais determinísticos são o fallback e barateiam o prompt — o LLM entra para síntese/explicação.
3. **Allowlist de contexto**: declare exatamente quais entidades/campos entram no prompt. Conteúdo de conversa exige `AiConsent`. Nada de payload bruto em logs ou em `contextSummary`.
4. **Tools**: cada leitura/ação = tool com `inputSchema` Zod e `execute` delegando a um service de domínio. Sem permissão/consentimento, a tool não entra no ToolSet. ToolSet tipado explicitamente.
5. **Prompt versionado**: registre `PromptVersion(capability, version, hash, changelog)`. Mudança de prompt = nova versão, nunca edição silenciosa.
6. **Execução**: teto de passos (`stopWhen`), timeout, orçamento de tokens; cancelamento aborta a geração. Persista `AiRun` em TODO caminho (sucesso, erro, recusa) com tokens e `costCents`.
7. **Ação externa** (se houver): gera `AiProposal` pendente; execução só após aprovação (`intelligence:approve`); execução aprovada delega ao service e audita com `actorType: 'ai'`.
8. **Eval**: fixtures + assertions (formato Zod válido + critérios objetivos da capacidade). CI roda contra fixtures; suite real roda quando `promptVersion` muda; regressão bloqueia o bump.
9. **UI**: a capacidade aparece como sinal/insight/próxima ação com token `--ai`, proveniência rotulada e explicação a um clique — nunca chat genérico.
10. **Revisão**: `security` (tools não ampliam permissão, contexto minimizado) + `reviewer` antes do commit.
