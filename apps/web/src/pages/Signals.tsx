import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AiConsentDto, AiProposalDto, AiUsageDto } from '@veyra/contracts';
import { clsx } from 'clsx';
import { Check, Sparkles, X } from 'lucide-react';
import { useState } from 'react';
import { Button } from '../components/ui/button';
import { api, ApiError } from '../lib/api';
import { hasPermission, useSession } from '../lib/session';

const dateTimeFormat = new Intl.DateTimeFormat('pt-BR', {
  dateStyle: 'short',
  timeStyle: 'short',
});
const money = (cents: number) => `US$ ${(cents / 100).toFixed(2)}`;

const statusLabels: Record<string, string> = {
  pending: 'Pendente',
  approved: 'Aprovada',
  rejected: 'Recusada',
  expired: 'Expirada',
};

export function SignalsPage() {
  const { data: user } = useSession();
  const canApprove = hasPermission(user, 'intelligence:approve');
  const canManage = hasPermission(user, 'workspace:manage');
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<'pending' | 'all'>('pending');
  const [error, setError] = useState<string | null>(null);

  const consent = useQuery({
    queryKey: ['ai-consent'],
    queryFn: () => api.get<AiConsentDto>('/api/intelligence/consent'),
  });
  const proposals = useQuery({
    queryKey: ['ai-proposals', status],
    queryFn: () => api.get<AiProposalDto[]>(`/api/intelligence/proposals?status=${status}`),
  });
  const usage = useQuery({
    queryKey: ['ai-usage'],
    queryFn: () => api.get<AiUsageDto>('/api/intelligence/usage?limit=20'),
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['ai-proposals'] });
    void queryClient.invalidateQueries({ queryKey: ['ai-usage'] });
    void queryClient.invalidateQueries({ queryKey: ['tasks'] });
  };

  const toggleConsent = useMutation({
    mutationFn: (next: boolean) =>
      api.put<AiConsentDto>('/api/intelligence/consent', { conversationContent: next }),
    /**
     * Atualização OTIMISTA: sem ela o checkbox volta ao valor antigo entre a
     * resposta e o refetch, e pisca. Em caso de falha, desfaz.
     */
    onMutate: async (next) => {
      await queryClient.cancelQueries({ queryKey: ['ai-consent'] });
      const previous = queryClient.getQueryData<AiConsentDto>(['ai-consent']);
      queryClient.setQueryData<AiConsentDto>(['ai-consent'], { conversationContent: next });
      return { previous };
    },
    onError: (e, _next, context) => {
      if (context?.previous) queryClient.setQueryData(['ai-consent'], context.previous);
      setError(e instanceof ApiError ? e.message : 'Falha ao salvar');
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ['ai-consent'] }),
  });
  const approve = useMutation({
    mutationFn: (id: string) =>
      api.post<{ taskId: string }>(`/api/intelligence/proposals/${id}/approve`),
    onSuccess: () => {
      setError(null);
      invalidate();
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Falha ao aprovar'),
  });
  const reject = useMutation({
    mutationFn: (id: string) => api.post<{ ok: true }>(`/api/intelligence/proposals/${id}/reject`),
    onSuccess: () => invalidate(),
  });

  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center gap-3 border-b border-border px-5 py-3">
        <Sparkles size={15} className="text-ai" />
        <div className="mr-auto">
          <h1 className="text-sm font-semibold">Sinais</h1>
          <p className="text-xs text-muted-fg">
            Propostas da IA aguardando decisão humana — nada é executado sem aprovação.
          </p>
        </div>
        <span className="font-mono text-xs tabular-nums text-muted-fg">
          {usage.data ? `${money(usage.data.totalCostCents)} em IA` : '—'}
        </span>
      </header>

      <div className="flex-1 overflow-auto p-5">
        {error ? (
          <p role="alert" className="mb-4 text-sm text-negative">
            {error}
          </p>
        ) : null}

        {/* consentimento: sem ele, resumo de conversa nem chama o provedor */}
        <section className="mb-6 max-w-2xl rounded-md border border-border p-3">
          <h2 className="text-xs font-medium uppercase tracking-wider text-muted-fg">
            Uso de conteúdo de conversa
          </h2>
          <p className="mt-1 text-[13px] text-muted-fg">
            Resumir conversas envia o texto das mensagens ao provedor de IA. Desligado, a capacidade
            não é oferecida e nenhuma chamada acontece.
          </p>
          <label className="mt-2 flex items-center gap-2 text-[13px]">
            <input
              type="checkbox"
              checked={consent.data?.conversationContent ?? false}
              disabled={!canManage || toggleConsent.isPending}
              onChange={(e) => toggleConsent.mutate(e.target.checked)}
              aria-label="Permitir uso de conteúdo de conversa"
            />
            Permitir uso de conteúdo de conversa
            {!canManage ? (
              <span className="text-xs text-muted-fg">(requer permissão de configuração)</span>
            ) : null}
          </label>
        </section>

        <div className="mb-2 flex items-center gap-2">
          <h2 className="mr-auto text-xs font-medium uppercase tracking-wider text-muted-fg">
            Propostas
          </h2>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setStatus(status === 'pending' ? 'all' : 'pending')}
          >
            {status === 'pending' ? 'Ver todas' : 'Só pendentes'}
          </Button>
        </div>

        <ul className="mb-8 max-w-3xl space-y-2">
          {(proposals.data ?? []).map((proposal) => (
            <li key={proposal.id} className="rounded-md border border-ai/30 bg-ai/5 p-3">
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] font-medium">
                    {String(proposal.payload.title ?? 'Ação proposta')}
                  </p>
                  <p className="mt-0.5 text-xs text-muted-fg">{proposal.rationale}</p>
                  <p className="mt-1 font-mono text-[10px] uppercase tracking-wider text-ai">
                    {proposal.type} · {statusLabels[proposal.status]} · expira em{' '}
                    {dateTimeFormat.format(new Date(proposal.expiresAt))}
                  </p>
                </div>
                {proposal.status === 'pending' && canApprove ? (
                  <div className="flex shrink-0 gap-1">
                    <Button size="sm" variant="primary" onClick={() => approve.mutate(proposal.id)}>
                      <Check size={13} /> Aprovar
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => reject.mutate(proposal.id)}>
                      <X size={13} /> Recusar
                    </Button>
                  </div>
                ) : null}
              </div>
            </li>
          ))}
          {proposals.data && proposals.data.length === 0 ? (
            <li className="py-12 text-center text-sm text-muted-fg">Nenhuma proposta pendente.</li>
          ) : null}
        </ul>

        <h2 className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-fg">
          Execuções recentes
        </h2>
        <table className="w-full max-w-4xl border-collapse text-[13px]">
          <thead>
            <tr className="border-b border-border">
              {['Quando', 'Capacidade', 'Resultado', 'Tokens', 'Custo'].map((header) => (
                <th
                  key={header}
                  className="py-2 text-left text-[11px] font-medium uppercase tracking-wider text-muted-fg"
                >
                  {header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(usage.data?.runs ?? []).map((run) => (
              <tr key={run.id} className="border-b border-border/60">
                <td className="whitespace-nowrap py-1.5 font-mono text-xs tabular-nums text-muted-fg">
                  {dateTimeFormat.format(new Date(run.createdAt))}
                </td>
                <td className="py-1.5 font-mono text-xs">{run.capability}</td>
                <td className="py-1.5">
                  <span
                    className={clsx(
                      'text-xs',
                      run.status === 'ok' ? 'text-positive' : 'text-warning',
                    )}
                  >
                    {run.status}
                    {run.reasonCode ? ` · ${run.reasonCode}` : ''}
                  </span>
                </td>
                <td className="py-1.5 font-mono text-xs tabular-nums text-muted-fg">
                  {run.inputTokens + run.outputTokens}
                </td>
                <td className="py-1.5 font-mono text-xs tabular-nums">{money(run.costCents)}</td>
              </tr>
            ))}
            {usage.data && usage.data.runs.length === 0 ? (
              <tr>
                <td colSpan={5} className="py-12 text-center text-sm text-muted-fg">
                  Nenhuma execução ainda.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
