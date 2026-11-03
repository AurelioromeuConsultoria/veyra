import { useQuery } from '@tanstack/react-query';
import type {
  ClinicsPackageCorrectionDto,
  ClinicsPackageDto,
  ClinicsPackageSessionsDto,
  ClinicsProfessionalDto,
} from '@veyra/contracts/verticals/clinics';
import { Button } from '../../components/ui/button';
import { api } from '../../lib/api';
import { PACKAGES_KEY, ROTULO_DO_MOTIVO_DA_CORRECAO, quandoLocal } from './continuidade';

/** O servidor devolve no máximo as 100 correções mais recentes (ADR-059, resultado 8). */
const LIMITE_DAS_CORRECOES = 100;

/**
 * As sessões de um pacote (ADR-059, F5.2b): os atendimentos que o consomem
 * AGORA e as correções que tiraram ou puseram uma sessão nele. Com 100
 * correções, a lista pode estar cortada, e a tela diz isso: o histórico inteiro
 * fica na trilha de auditoria.
 */
export function SessoesDoPacote({
  pacote,
  fuso,
}: {
  pacote: ClinicsPackageDto;
  fuso: string | null;
}) {
  const sessoes = useQuery({
    queryKey: [...PACKAGES_KEY, 'sessions', pacote.id],
    queryFn: () =>
      api.get<ClinicsPackageSessionsDto>(`/api/clinics/packages/${pacote.id}/sessions`),
  });
  // os arquivados também: uma sessão antiga pode ser de quem não atende mais
  const profissionais = useQuery({
    queryKey: ['clinics', 'catalog', 'professionals', true],
    queryFn: () =>
      api.get<ClinicsProfessionalDto[]>('/api/clinics/professionals?includeArchived=true'),
  });
  const nomeDo = (id: string) =>
    profissionais.data?.find((p) => p.id === id)?.name ?? 'Profissional';
  const quando = (iso: string) => quandoLocal(iso, fuso);
  const sentido = (c: ClinicsPackageCorrectionDto) => {
    // com as contrações do português: "deste pacote", não "de este pacote"
    const origem = (id: string | null) =>
      id === null ? 'de avulso' : id === pacote.id ? 'deste pacote' : 'de outro pacote';
    const destino = (id: string | null) =>
      id === null ? 'para avulso' : id === pacote.id ? 'para este pacote' : 'para outro pacote';
    return `${origem(c.fromPackageId)} ${destino(c.toPackageId)}`;
  };

  if (sessoes.isError) {
    return (
      <div className="space-y-2 p-5">
        <p role="alert" className="text-data text-negative">
          Não foi possível carregar as sessões deste pacote.
        </p>
        <Button size="sm" variant="ghost" onClick={() => void sessoes.refetch()}>
          Tentar de novo
        </Button>
      </div>
    );
  }
  if (!sessoes.data) {
    return <p className="p-5 text-data text-muted-fg">Carregando as sessões…</p>;
  }
  const { sessions, corrections } = sessoes.data;
  return (
    <div className="space-y-4 p-5">
      <section aria-label="Sessões consumidas" className="space-y-1">
        <p className="eyebrow text-muted-fg">
          Consomem este pacote agora ({sessions.length} de {pacote.totalSessions})
        </p>
        {/* D8 (ADR-061): o servidor devolve só as do próprio profissional; o
            saldo do pacote inclui as dos outros, que não aparecem aqui */}
        {pacote.consumedSessions > sessions.length ? (
          <p className="text-data text-muted-fg">
            O saldo inclui {pacote.consumedSessions - sessions.length}{' '}
            {pacote.consumedSessions - sessions.length === 1 ? 'sessão' : 'sessões'} de outros
            profissionais, que não aparecem aqui.
          </p>
        ) : null}
        {sessions.length === 0 ? (
          <p className="text-body-sm text-muted-fg">Nenhuma sessão consumida.</p>
        ) : (
          <ul className="space-y-1">
            {sessions.map((s) => (
              <li key={s.attendanceId} className="text-body-sm">
                {quando(s.completedAt)} · {nomeDo(s.professionalId)}
                {s.consumptionRevision > 0 ? ' · consumo corrigido' : ''}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section aria-label="Correções" className="space-y-1">
        <p className="eyebrow text-muted-fg">Correções que tocaram este pacote</p>
        {corrections.length === 0 ? (
          <p className="text-body-sm text-muted-fg">Nenhuma correção.</p>
        ) : (
          <ul className="space-y-1">
            {corrections.map((c) => (
              <li key={c.id} className="text-body-sm">
                {quando(c.createdAt)} · {sentido(c)} · {ROTULO_DO_MOTIVO_DA_CORRECAO[c.reason]}
              </li>
            ))}
          </ul>
        )}
        {corrections.length >= LIMITE_DAS_CORRECOES ? (
          <p className="text-data text-muted-fg">
            Mostrando as {LIMITE_DAS_CORRECOES} correções mais recentes. O histórico completo fica
            na trilha de auditoria.
          </p>
        ) : null}
      </section>
    </div>
  );
}
