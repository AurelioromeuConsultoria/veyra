import { Suspense, lazy } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import {
  ExperienceShell,
  Incompativel,
  useIncompativel,
  useTituloNeutro,
} from './components/layout/ExperienceShell';
import { EXPERIENCIAS_DE_EXTENSAO } from './composition';
import { crmExperience } from './experiences/crm';
import type { ExperienceManifest } from './lib/experience';
import { useSession } from './lib/session';
import { LoginPage } from './pages/Login';

const AcceptInvitePage = lazy(() =>
  import('./pages/AcceptInvite').then((m) => ({ default: m.AcceptInvitePage })),
);

/**
 * As experiências que este web monta (ADR-055, adendo 2): a do Core (`crm`) e as
 * que as extensões declaram pela raiz de composição. A da sessão vem do
 * servidor; chave fora desta lista é "desconhecida", nunca o CRM.
 */
const MANIFESTOS: readonly ExperienceManifest[] = [crmExperience, ...EXPERIENCIAS_DE_EXTENSAO];

function Loading() {
  return (
    <main className="flex min-h-screen items-center justify-center text-sm text-muted-fg">
      Carregando…
    </main>
  );
}

/**
 * A sessão carregando (também logo depois de uma troca): o título também não
 * guarda a tela anterior. Só aqui — o `Loading` do `Suspense` cobre um produto
 * montado, cujo cabeçalho não reescreveria o título ao voltar.
 */
function CarregandoSessao() {
  useTituloNeutro();
  return <Loading />;
}

function Protected({ children }: { children: React.ReactNode }) {
  const { data: user, isLoading } = useSession();
  if (isLoading) return <CarregandoSessao />;
  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

export function App() {
  // a aba que parou por incompatibilidade de sessão mostra SÓ isso, acima de
  // qualquer rota — nem o login funciona até a página ser atualizada
  const incompativel = useIncompativel();
  if (incompativel) return <Incompativel />;
  return (
    <Suspense fallback={<Loading />}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        {/* pública: o aceite acontece antes de existir sessão (ADR-054 item 4) */}
        <Route path="/convite" element={<AcceptInvitePage />} />
        <Route
          path="*"
          element={
            <Protected>
              <ExperienceShell manifestos={MANIFESTOS} />
            </Protected>
          }
        />
      </Routes>
    </Suspense>
  );
}
