---
name: create-vertical
description: Create or extend a vertical product (e.g. Veyra Clinics) on top of the Core — extension tables, custom fields, own entities, and bootstrap composition. The Core must never learn about the vertical.
---

# create-vertical

Referências: `docs/ARCHITECTURE.md §6`, `docs/PRODUCT_BRIEF.md §5`, ADR-015.

## Passos

1. **Cheque a direção da dependência**: o vertical importa serviços do Core; o Core **nunca** importa, referencia ou "prevê" o vertical. Se a feature exige mudar o Core, a mudança precisa ser universal (útil a qualquer vertical) e passa pelo `architect` com ADR.
2. **Escolha o mecanismo de extensão**, nesta ordem de preferência:
   - **Custom fields** do Core: atributo simples sem estrutura (ex.: "convênio" como select).
   - **Extension table 1:1**: estrutura própria sobre entidade do Core — ex.: `ClinicsPatient(workspaceId, contactId, ...)` com `@@unique([workspaceId, contactId])` e **FK composta** para `Contact(workspaceId, id)`.
   - **Entidade própria do vertical**: conceito que não estende nada (ex.: `ClinicUnit`) — mesmas convenções do Core (workspaceId, WORKSPACE_MODELS do vertical, índices compostos).
3. **Leitura estendida**: "paciente" = join da extension table com `Contact` via service do vertical; nunca duplique dados do Core na extensão.
4. **Parametrize o Core em vez de reimplementar**: automações (confirmação/no-show), agenda (slots), IA (reativação) usam as APIs públicas dos services do Core com configuração do vertical.
5. **Permissões do vertical**: keys próprias (`clinics:patients:read`, ...) somadas ao catálogo; roles de sistema do vertical semeados no provisionamento do workspace que ativa o vertical.
6. **Composição**: o app final importa `CoreModule` + `<Vertical>Module` no bootstrap. Sem plugin registry no Core.
7. **Testes**: isolamento de tenant nas tabelas do vertical (mesmo P0), FK composta impede paciente apontar para contato de outro workspace, e o Core continua compilando/passando **sem** o vertical presente.
8. **LGPD reforçada**: dado sensível do vertical (ex.: saúde) exige allowlist de auditoria estrita, consentimento de IA próprio e revisão de `security`.
