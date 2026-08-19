---
name: release-checklist
description: Pre-release verification — CI green, migrations safe and paired, isolation tests passing, secrets clean, docs updated, rollback plan. Push and deploy only when explicitly requested.
---

# release-checklist

Referências: `CLAUDE.md §6` (DoD), `docs/SECURITY.md §10`, `docs/ROADMAP.md` (critérios "pronto quando").

## Passos

1. **Estado do repo**: `git status` limpo; `git log` revisado — cada commit conta uma mudança coerente; nenhum commit "wip" sobrando.
2. **Validações**: lint, typecheck, builds (api e web), unit + integração + e2e verdes localmente e no CI. Teste P0 de isolamento e `check:fk` passam.
3. **Migrations**: aplicam do zero (`migrate deploy` em banco limpo) e sobre o banco do release anterior; nenhuma destrutiva sem plano aprovado; comitadas junto do código que as usa.
4. **Segurança**: mudanças sensíveis desta release passaram por `security-review` com veredito aprovado; nenhum segredo no diff da release; env novas documentadas em `.env.example` (placeholders) e validadas no boot.
5. **IA**: evals das capacidades tocadas verdes; `promptVersion` bumped com changelog se prompt mudou.
6. **Docs**: `docs/DECISIONS.md` (ADRs novos), `docs/ROADMAP.md` (status), demais docs afetados — atualizados. Drift de documentação bloqueia release.
7. **Rollback**: sabe-se exatamente como voltar (release anterior + migrations compatíveis para trás). Migration que impede rollback → duas releases (expand/contract).
8. **Push/deploy**: somente se o usuário pediu explicitamente. Push dispara o hook de DoD — responda ao checklist com verdade.
9. **Pós-release**: healthcheck ok; erros monitorados na primeira hora; anotar issues conhecidas descobertas.
