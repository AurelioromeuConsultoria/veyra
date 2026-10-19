import { clsx } from 'clsx';
import { useSearchParams } from 'react-router-dom';
import { EmptyState, PageHeader } from '../../components/ui/page';
import { useClinicsAccess } from './access';
import { ProfessionalsTab } from './catalog/ProfessionalsTab';
import { ServicesTab } from './catalog/ServicesTab';
import { UnitTab } from './catalog/UnitTab';

const TABS = [
  { key: 'servicos', label: 'Serviços' },
  { key: 'profissionais', label: 'Profissionais' },
  { key: 'unidade', label: 'Unidade' },
] as const;
type TabKey = (typeof TABS)[number]['key'];

/**
 * Catálogo da clínica (ADR-048 adendo 1). PORTA antes de tudo: nada do catálogo
 * é montado — e portanto nada é consultado — até o status confirmar o vertical
 * ATIVO e a pessoa ter `clinics:catalog:read` (item 21). Carregando, com erro,
 * inativo ou sem permissão: só a mensagem.
 */
export function ClinicsCatalogPage() {
  const access = useClinicsAccess('clinics:catalog:read');
  if (access === 'loading') {
    return <p className="p-6 text-body-sm text-muted-fg">Carregando…</p>;
  }
  if (access !== 'ready') {
    const mensagem = {
      error: {
        title: 'Não foi possível verificar o Clinics agora.',
        hint: 'Tente de novo em instantes.',
      },
      inactive: {
        title: 'O Clinics não está ativo neste workspace.',
        hint: 'A ativação é feita pela equipe da Veyra.',
      },
      forbidden: {
        title: 'Você não tem acesso ao catálogo da clínica.',
        hint: 'Peça a quem administra o workspace.',
      },
    }[access];
    return (
      <div className="flex h-full flex-col">
        <PageHeader eyebrow="Clínica" title="Catálogo" />
        <EmptyState title={mensagem.title} hint={mensagem.hint} />
      </div>
    );
  }
  return <CatalogReady />;
}

function CatalogReady() {
  const [params, setParams] = useSearchParams();
  const tab: TabKey = TABS.some((t) => t.key === params.get('aba'))
    ? (params.get('aba') as TabKey)
    : 'servicos';

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        eyebrow="Clínica"
        title="Catálogo"
        meta="Serviços, profissionais e horários de atendimento da clínica."
      />
      <div
        role="tablist"
        aria-label="Partes do catálogo"
        className="flex gap-1 border-b border-border bg-surface px-6"
      >
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            id={`aba-${t.key}`}
            aria-controls="painel-catalogo"
            aria-selected={tab === t.key}
            onClick={() => setParams({ aba: t.key }, { replace: true })}
            className={clsx(
              '-mb-px border-b-2 px-3 py-2 text-body-sm transition-colors',
              tab === t.key
                ? 'border-accent font-medium text-foreground'
                : 'border-transparent text-muted-fg hover:text-foreground',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id="painel-catalogo"
        aria-labelledby={`aba-${tab}`}
        className="min-h-0 flex-1 overflow-auto p-6"
      >
        {tab === 'servicos' ? <ServicesTab /> : null}
        {tab === 'profissionais' ? <ProfessionalsTab /> : null}
        {tab === 'unidade' ? <UnitTab /> : null}
      </div>
    </div>
  );
}
