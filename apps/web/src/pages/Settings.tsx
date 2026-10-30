import { clsx } from 'clsx';
import { Link } from 'react-router-dom';
import { EmptyState, PageBody, PageHeader, Panel } from '../components/ui/page';
import { secoesAlcancaveis, useExperience } from '../lib/experience';
import { useSession } from '../lib/session';

/**
 * As configurações do produto (ADR-055, adendo 2): uma página, organizada nas
 * seções que o manifesto da experiência declara. Cada seção só aparece com a
 * permissão da rota dela — a mesma que o servidor exige.
 */
export function SettingsPage() {
  const { data: user } = useSession();
  const experiencia = useExperience();
  const secoes = secoesAlcancaveis(experiencia, user);
  return (
    <div className="flex h-full flex-col">
      <PageHeader title="Configurações" meta={`As configurações do ${experiencia.produto}.`} />
      <PageBody>
        {secoes.length === 0 ? (
          <EmptyState
            title="Nenhuma configuração disponível para o seu papel."
            hint="Quem administra o workspace pode ajustar o seu acesso."
          />
        ) : (
          <ul className="grid max-w-4xl gap-3 sm:grid-cols-2">
            {secoes.map(({ to, label, description, icon: Icon, destinos }) => (
              <li key={to}>
                <Panel className="h-full transition-colors duration-150 hover:border-border-strong">
                  <Link
                    to={to}
                    className={clsx('flex items-start gap-3 p-4', !destinos?.length && 'h-full')}
                  >
                    <Icon size={16} strokeWidth={1.75} className="mt-0.5 shrink-0 text-muted-fg" />
                    <span>
                      <span className="block text-body-sm font-medium">{label}</span>
                      <span className="mt-0.5 block text-data text-muted-fg">{description}</span>
                    </span>
                  </Link>
                  {destinos?.length ? (
                    <p className="-mt-2 flex gap-3 px-4 pb-4 pl-11 text-data">
                      {destinos.map((d) => (
                        <Link key={d.to} to={d.to} className="text-accent hover:underline">
                          {d.label}
                        </Link>
                      ))}
                    </p>
                  ) : null}
                </Panel>
              </li>
            ))}
          </ul>
        )}
      </PageBody>
    </div>
  );
}
