import {
  somarDias,
  type ClinicsNoShowDto,
  type ClinicsNoShowProfessionalDto,
  type ClinicsNoShowWeekDto,
} from '@veyra/contracts/verticals/clinics';
import { clsx } from 'clsx';
import type { ReactNode } from 'react';
import { Avatar } from '../../../components/ui/avatar';
import { Panel, PanelHeader } from '../../../components/ui/page';

/**
 * As séries da taxa de faltas e a comparação com o período anterior (ADR-062
 * adendo 1, item A2). A conta é sempre a do servidor (`rate`); aqui só se
 * desenha. Barras em CSS puro, sem biblioteca de gráfico: a escala vai de 0 à
 * MAIOR taxa da série, e cada barra leva o número escrito, porque a altura
 * sozinha não diz a taxa.
 */

/** A taxa na tela: `null` é "Sem dados", e só ele. */
export function taxaLegivel(rate: number | null): string {
  if (rate === null) return 'Sem dados';
  const pct = rate * 100;
  // uma taxa positiva pequena nunca aparece como o 0 % legítimo (nem a quase
  // total como 100 %): o arredondamento não apaga a diferença
  if (rate > 0 && pct < 0.05) return '< 0,1 %';
  if (rate < 1 && pct >= 99.95) return '> 99,9 %';
  return `${new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 }).format(pct)} %`;
}

/** Dias de calendário entre duas datas `AAAA-MM-DD` (`ate` exclusivo). */
export function diasEntre(de: string, ate: string): number {
  return Math.round((Date.parse(`${ate}T00:00:00Z`) - Date.parse(`${de}T00:00:00Z`)) / 86_400_000);
}

/** O período anterior de MESMO tamanho: termina onde o atual começa. */
export function periodoAnterior(periodo: { de: string; ate: string }): { de: string; ate: string } {
  return { de: somarDias(periodo.de, -diasEntre(periodo.de, periodo.ate)), ate: periodo.de };
}

/**
 * O período anterior por extenso, com a preposição já contraída: `a` para "em
 * relação a" ("aos 30 dias anteriores", "à semana anterior") e `em` para "sem
 * dados em" ("nos 30 dias anteriores", "na semana anterior").
 */
export function oPeriodoAnterior(dias: number): { a: string; em: string } {
  if (dias === 1) return { a: 'ao dia anterior', em: 'no dia anterior' };
  if (dias === 7) return { a: 'à semana anterior', em: 'na semana anterior' };
  if (dias % 7 === 0) {
    const n = dias / 7;
    return { a: `às ${n} semanas anteriores`, em: `nas ${n} semanas anteriores` };
  }
  return { a: `aos ${dias} dias anteriores`, em: `nos ${dias} dias anteriores` };
}

/**
 * A diferença entre duas taxas em PONTOS PERCENTUAIS, por extenso. Uma
 * diferença real pequena nunca vira "0 p.p." (o 0 é só a igualdade exata).
 */
export function pontosLegiveis(atual: number, anterior: number): string {
  const pp = Math.abs(atual - anterior) * 100;
  if (pp > 0 && pp < 0.05) return '< 0,1 p.p.';
  return `${new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 }).format(pp)} p.p.`;
}

/**
 * A comparação com o período anterior, abaixo da taxa: a mesma consulta no
 * intervalo anterior de mesmo tamanho. Subir a taxa de faltas é ruim
 * (vermelho, ↑); cair é bom (verde, ↓). A seta é decorativa: o texto diz o
 * sentido para o leitor de tela.
 */
export function ComparacaoDaTaxa({
  atual,
  anterior,
  dias,
}: {
  atual: number | null;
  /** `undefined` = carregando; `'erro'` = falhou */
  anterior: ClinicsNoShowDto | 'erro' | undefined;
  dias: number;
}) {
  // sem taxa agora, não há o que comparar (a legenda do cartão já diz "sem dados")
  if (atual === null) return null;
  const contra = oPeriodoAnterior(dias);
  let conteudo: ReactNode;
  let tom = 'text-muted-fg';
  if (anterior === undefined) conteudo = 'Comparando com o período anterior…';
  else if (anterior === 'erro') conteudo = 'Não foi possível comparar com o período anterior.';
  else if (anterior.rate === null) conteudo = `Sem dados ${contra.em} para comparar.`;
  else if (anterior.rate === atual) conteudo = `Igual ${contra.a}.`;
  else {
    const subiu = atual > anterior.rate;
    tom = subiu ? 'text-negative' : 'text-positive';
    conteudo = (
      <>
        <span aria-hidden>{subiu ? '↑' : '↓'}</span>{' '}
        <span className="sr-only">{subiu ? 'Subiu' : 'Caiu'} </span>
        <span className="num">{pontosLegiveis(atual, anterior.rate)}</span> em relação {contra.a}
        <span className="text-muted-fg"> ({taxaLegivel(anterior.rate)})</span>
      </>
    );
  }
  return (
    <dd data-testid="comparacao-das-faltas" className={clsx('text-[13px] font-medium', tom)}>
      {conteudo}
    </dd>
  );
}

/** `2026-10-12` → `12/10` */
function diaEMes(data: string): string {
  const [, mes, dia] = data.split('-');
  return `${dia}/${mes}`;
}

function detalhe(c: { noShow: number; attended: number; rate: number | null }): string {
  if (c.rate === null) return 'sem dados';
  return `${c.noShow} ${c.noShow === 1 ? 'falta' : 'faltas'} em ${c.attended + c.noShow}`;
}

/**
 * "Faltas por semana": uma barra por semana (segunda a domingo, no fuso da
 * unidade), todas as semanas que o período toca. A semana cortada pelo período
 * leva "parcial". Com muitas semanas, o número sai de cima da barra e o rótulo
 * aparece a cada tantas, para não amontoar; o texto inteiro está no rótulo
 * acessível do gráfico e na dica de cada barra.
 */
export function FaltasPorSemana({ semanas }: { semanas: ClinicsNoShowWeekDto[] }) {
  const maior = Math.max(0, ...semanas.map((s) => s.rate ?? 0));
  const vazio = semanas.every((s) => s.rate === null);
  const denso = semanas.length > 12;
  const passo = Math.ceil(semanas.length / 12);
  const parcial = (s: ClinicsNoShowWeekDto) =>
    s.from !== s.weekStart || s.to !== somarDias(s.weekStart, 7);
  const leitura = (s: ClinicsNoShowWeekDto) =>
    `${s.rate === null ? 'sem dados' : taxaLegivel(s.rate)} na semana de ${diaEMes(s.weekStart)}${parcial(s) ? ' (parcial)' : ''}`;

  return (
    <Panel aria-label="Faltas por semana">
      <PanelHeader
        title="Faltas por semana"
        meta="Faltas sobre atendidos + faltas de cada semana, de segunda a domingo."
      />
      {vazio ? (
        <p className="px-5 py-6 text-[13.5px] text-muted-fg">
          Nenhum atendido nem falta nas semanas do período.
        </p>
      ) : (
        <div
          role="img"
          aria-label={`Faltas por semana: ${semanas.map(leitura).join('; ')}.`}
          className="px-5 pb-5 pt-4"
        >
          <div
            className="grid h-44 items-end gap-x-3 border-b border-border px-2"
            style={{ gridTemplateColumns: `repeat(${semanas.length}, minmax(0, 1fr))` }}
          >
            {semanas.map((s) => (
              <div
                key={s.weekStart}
                title={`Semana de ${diaEMes(s.weekStart)}: ${s.rate === null ? 'sem dados' : `${taxaLegivel(s.rate)}, ${detalhe(s)}`}`}
                className="flex h-full flex-col items-center justify-end gap-1.5"
              >
                {denso ? null : (
                  <span className="num text-[12.5px] font-medium">
                    {s.rate === null ? '—' : taxaLegivel(s.rate)}
                  </span>
                )}
                <div className="relative w-full flex-1">
                  {s.rate === null ? null : (
                    <div
                      className={clsx(
                        'absolute inset-x-0 bottom-0 mx-auto max-w-[72px] rounded-t-md',
                        s.rate > 0 ? 'bg-accent' : 'bg-border-strong',
                      )}
                      // a taxa 0 é legítima: um filete, para não parecer "sem dados"
                      style={{
                        height: s.rate > 0 && maior > 0 ? `${(s.rate / maior) * 100}%` : '2px',
                      }}
                    />
                  )}
                </div>
              </div>
            ))}
          </div>
          <div
            className="mt-2 grid gap-x-3 px-2"
            style={{ gridTemplateColumns: `repeat(${semanas.length}, minmax(0, 1fr))` }}
          >
            {semanas.map((s, i) => (
              <span
                key={s.weekStart}
                className="truncate text-center text-[12.5px] leading-tight text-muted-fg"
              >
                {i % passo === 0 ? (
                  <>
                    Sem. de <span className="num">{diaEMes(s.weekStart)}</span>
                    {parcial(s) && !denso ? (
                      <span className="block text-[11.5px]">parcial</span>
                    ) : null}
                  </>
                ) : null}
              </span>
            ))}
          </div>
        </div>
      )}
    </Panel>
  );
}

/**
 * "Por profissional": cada profissional com agendamento no período, com o
 * avatar, a barra (escala até a maior taxa da lista) e "faltas de atendidos +
 * faltas · taxa". Carga, erro e vazio dentro do painel.
 */
export function FaltasPorProfissional({
  profissionais,
  erro,
}: {
  /** `undefined` = carregando */
  profissionais: ClinicsNoShowProfessionalDto[] | undefined;
  erro: boolean;
}) {
  const lista = profissionais ?? [];
  const maior = Math.max(0, ...lista.map((p) => p.rate ?? 0));
  return (
    <Panel aria-label="Por profissional">
      <PanelHeader title="Por profissional" />
      {erro ? (
        <p role="alert" className="px-5 py-6 text-[13.5px] text-negative">
          Não foi possível carregar as faltas por profissional.
        </p>
      ) : profissionais === undefined ? (
        <p className="px-5 py-6 text-[13.5px] text-muted-fg">Carregando…</p>
      ) : lista.length === 0 ? (
        <p className="px-5 py-6 text-[13.5px] text-muted-fg">Nenhum agendamento no período.</p>
      ) : (
        <ul>
          {lista.map((p) => (
            <li
              key={p.professionalId}
              aria-label={`${p.professionalName}: ${p.rate === null ? 'sem dados' : `${taxaLegivel(p.rate)}, ${detalhe(p)} (atendidos + faltas)`}`}
              className="flex items-center gap-3.5 border-b border-border px-5 py-3.5 last:border-b-0"
            >
              <Avatar nome={p.professionalName} chave={p.professionalId} />
              <span className="min-w-0 flex-1 truncate text-[14px] font-semibold">
                {p.professionalName}
              </span>
              <span
                aria-hidden
                className="hidden h-2 w-40 overflow-hidden rounded-full bg-surface-2 sm:block md:w-64"
              >
                {p.rate !== null && p.rate > 0 && maior > 0 ? (
                  <span
                    className="block h-2 rounded-full bg-state-missed-fg"
                    style={{ width: `${(p.rate / maior) * 100}%` }}
                  />
                ) : null}
              </span>
              <span aria-hidden className="num w-36 text-right text-[13px]">
                {p.rate === null
                  ? 'Sem dados'
                  : `${p.noShow} de ${p.attended + p.noShow} · ${taxaLegivel(p.rate)}`}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
