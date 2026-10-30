import { useMutation } from '@tanstack/react-query';
import type { AuthUserDto } from '@veyra/contracts';
import { clsx } from 'clsx';
import { Check, ChevronsUpDown } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';
import { produtoDa, type ExperienceManifest } from '../../lib/experience';
import { useSession } from '../../lib/session';

/**
 * O seletor de workspace (ADR-055, adendo 2, item 6): as memberships ATIVAS da
 * própria sessão, cada uma com o produto dela, e a troca pela rota do servidor.
 * A troca é troca de sessão (ADR-050): cache novo e respostas antigas
 * descartadas pela época. Depois dela, a tela vai ao início do produto
 * escolhido — a rota em que a pessoa estava pode não existir nele.
 */
export function WorkspaceSwitcher({
  manifestos,
  variante = 'rastro',
}: {
  manifestos: readonly ExperienceManifest[];
  /** `rastro`: no cabeçalho; `lista`: na tela neutra, aberto */
  variante?: 'rastro' | 'lista';
}) {
  const { data: user } = useSession();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    const onPointer = (event: PointerEvent) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
    };
  }, [open]);

  const trocar = useMutation({
    mutationFn: (membershipId: string) =>
      api.post<AuthUserDto>('/api/auth/switch-workspace', { membershipId }),
    // a resposta EMITE sessão: o `lib/api.ts` já trocou de sessão ao vê-la. O
    // `onSuccess` roda numa microtarefa, antes do render agendado pela troca: a
    // URL muda antes de a árvore nova montar (o E2E confere que a volta não cai
    // no aviso de "fora da experiência"). Vale enquanto nenhum `onSuccess`
    // global do `MutationCache` esperar I/O antes deste
    onSuccess: () => navigate('/', { replace: true }),
  });

  const atual = user?.activeMembership?.membershipId ?? null;
  const opcoes = (user?.memberships ?? []).filter((m) => m.status === 'active');
  const nome = user?.activeMembership?.workspaceName;

  const lista = (
    <ul aria-label="Workspaces" className="py-1">
      {opcoes.map((m) => {
        const eAtual = m.membershipId === atual;
        return (
          <li key={m.membershipId}>
            <button
              type="button"
              disabled={eAtual || trocar.isPending}
              onClick={() => trocar.mutate(m.membershipId)}
              aria-current={eAtual ? 'true' : undefined}
              className={clsx(
                'flex w-full items-center gap-2 px-3 py-2 text-left text-body-sm transition-colors duration-150',
                eAtual ? 'cursor-default' : 'hover:bg-surface-2',
              )}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{m.workspaceName}</span>
                <span className="block truncate text-data-sm text-muted-fg">
                  {produtoDa(m.experience, manifestos)} · {m.roleName}
                </span>
              </span>
              {eAtual ? <Check size={14} aria-hidden className="shrink-0 text-accent" /> : null}
            </button>
          </li>
        );
      })}
    </ul>
  );
  const erro = trocar.error ? (
    <p role="alert" className="px-3 pb-2 text-data text-negative">
      {trocar.error instanceof ApiError ? trocar.error.message : 'Não foi possível trocar.'}
    </p>
  ) : null;

  if (variante === 'lista') {
    if (opcoes.length === 0) return null;
    return (
      <div className="rounded-card border border-border bg-surface">
        <p className="eyebrow px-3 pt-3 text-muted-fg">Escolha um workspace</p>
        {lista}
        {erro}
      </div>
    );
  }

  // com um workspace só, não há o que trocar: o nome, sem seletor
  if (opcoes.length <= 1) {
    return <span className="truncate text-body-sm font-medium text-foreground">{nome ?? '—'}</span>;
  }
  return (
    <div className="relative min-w-0" ref={box}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={`Workspace: ${nome ?? 'nenhum'}. Trocar de workspace`}
        aria-expanded={open}
        aria-haspopup="dialog"
        className="flex min-w-0 items-center gap-1 rounded-control px-1 py-0.5 text-body-sm font-medium text-foreground transition-colors duration-150 hover:bg-surface-2"
      >
        <span className="truncate">{nome ?? '—'}</span>
        <ChevronsUpDown size={13} aria-hidden className="shrink-0 text-muted-fg" />
      </button>
      {open ? (
        <div
          role="dialog"
          aria-label="Trocar de workspace"
          className="absolute left-0 top-full z-40 mt-1 w-72 overflow-hidden rounded-card border border-border bg-surface shadow-float"
        >
          {lista}
          {erro}
        </div>
      ) : null}
    </div>
  );
}
