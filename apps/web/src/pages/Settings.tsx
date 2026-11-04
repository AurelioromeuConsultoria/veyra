import { ChevronRight } from 'lucide-react';
import { Link } from 'react-router-dom';
import { EmptyState, PageBody, PageHeader, Panel } from '../components/ui/page';
import { secoesAlcancaveis, useExperience, type SettingsSection } from '../lib/experience';
import { useSession } from '../lib/session';

/**
 * As seções alcançáveis, agrupadas (ADR-062): cada grupo na ordem da primeira
 * seção dele no manifesto. A seção sem grupo fica num bloco sem título, no
 * lugar em que aparece. Só apresentação: o filtro de permissão vem antes.
 */
export function agruparSecoes(
  secoes: readonly SettingsSection[],
): { grupo: string | null; secoes: SettingsSection[] }[] {
  const grupos: { grupo: string | null; secoes: SettingsSection[] }[] = [];
  for (const secao of secoes) {
    const nome = secao.grupo ?? null;
    const existente = grupos.find((g) => g.grupo === nome);
    if (existente) existente.secoes.push(secao);
    else grupos.push({ grupo: nome, secoes: [secao] });
  }
  return grupos;
}

/**
 * As configurações do produto (ADR-055, adendo 2): uma página, organizada nas
 * seções que o manifesto da experiência declara. Cada seção só aparece com a
 * permissão da rota dela — a mesma que o servidor exige. No redesenho
 * (ADR-062), as seções vêm em grupos, uma linha por seção: o ícone, o nome e a
 * frase do que se ajusta ali.
 */
export function SettingsPage() {
  const { data: user } = useSession();
  const experiencia = useExperience();
  const grupos = agruparSecoes(secoesAlcancaveis(experiencia, user));
  return (
    <div className="flex h-full flex-col">
      <PageHeader title="Configurações" meta={`As configurações do ${experiencia.produto}.`} />
      <PageBody>
        {grupos.length === 0 ? (
          <EmptyState
            title="Nenhuma configuração disponível para o seu papel."
            hint="Quem administra o workspace pode ajustar o seu acesso."
          />
        ) : (
          <div className="max-w-3xl space-y-6">
            {grupos.map(({ grupo, secoes }) => (
              <section key={grupo ?? '—'}>
                {grupo ? (
                  <h2 className="mb-2 px-1 text-[13px] font-semibold text-muted-fg">{grupo}</h2>
                ) : null}
                <Panel>
                  <ul className="divide-y divide-border">
                    {secoes.map((secao) => (
                      <LinhaDaSecao key={secao.to} secao={secao} />
                    ))}
                  </ul>
                </Panel>
              </section>
            ))}
          </div>
        )}
      </PageBody>
    </div>
  );
}

function LinhaDaSecao({
  secao: { to, label, description, icon: Icon, destinos },
}: {
  secao: SettingsSection;
}) {
  return (
    <li className="group flex flex-wrap items-center gap-x-4 gap-y-2 transition-colors duration-150 hover:bg-surface-2">
      <Link to={to} className="flex min-w-0 flex-1 items-center gap-4 px-5 py-4">
        <span
          aria-hidden
          className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] border border-border bg-surface-2 text-foreground"
        >
          <Icon size={18} strokeWidth={1.75} />
        </span>
        <span className="min-w-0">
          <span className="block text-[15px] font-semibold">{label}</span>
          <span className="mt-0.5 block text-[13.5px] text-muted-fg">{description}</span>
        </span>
        {destinos?.length ? null : (
          <ChevronRight
            size={16}
            aria-hidden
            className="ml-auto shrink-0 text-muted-fg transition-transform duration-150 group-hover:translate-x-0.5"
          />
        )}
      </Link>
      {destinos?.length ? (
        // os destinos da seção ("Tags", "Campos") ao lado: um link dentro do
        // outro não é HTML válido, e cada um é um lugar de verdade
        <p className="flex shrink-0 gap-2 pb-4 pl-[76px] pr-5 sm:py-4 sm:pl-0">
          {destinos.map((d) => (
            <Link
              key={d.to}
              to={d.to}
              className="inline-flex h-8 items-center gap-1 rounded-control border border-border-strong bg-surface px-3 text-[13px] font-medium hover:border-accent hover:text-accent"
            >
              {d.label}
              <ChevronRight size={14} aria-hidden />
            </Link>
          ))}
        </p>
      ) : null}
    </li>
  );
}
