import { Suspense, lazy } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from './components/layout/AppShell';
import { useVerticalNavGroups, VERTICAL_ROUTES } from './composition';
import { NavContributionsProvider } from './lib/nav';
import { useSession } from './lib/session';
import { LoginPage } from './pages/Login';
import { TodayPage } from './pages/Today';

/**
 * Code-splitting por rota: o chunk inicial carrega só login + shell; kanban,
 * tabelas e timeline chegam sob demanda (dívida técnica da Entrega 3 quitada
 * antes de o board entrar).
 */
const ContactsPage = lazy(() =>
  import('./pages/Contacts').then((m) => ({ default: m.ContactsPage })),
);
const CompaniesPage = lazy(() =>
  import('./pages/Companies').then((m) => ({ default: m.CompaniesPage })),
);
const PipelinePage = lazy(() =>
  import('./pages/Pipeline').then((m) => ({ default: m.PipelinePage })),
);
const CalendarPage = lazy(() =>
  import('./pages/Calendar').then((m) => ({ default: m.CalendarPage })),
);
const AutomationsPage = lazy(() =>
  import('./pages/Automations').then((m) => ({ default: m.AutomationsPage })),
);
const UsagePage = lazy(() => import('./pages/Usage').then((m) => ({ default: m.UsagePage })));
const SignalsPage = lazy(() => import('./pages/Signals').then((m) => ({ default: m.SignalsPage })));
const InboxPage = lazy(() => import('./pages/Inbox').then((m) => ({ default: m.InboxPage })));
const TasksPage = lazy(() => import('./pages/Tasks').then((m) => ({ default: m.TasksPage })));
const TagsPage = lazy(() => import('./pages/Tags').then((m) => ({ default: m.TagsPage })));
const CustomFieldsPage = lazy(() =>
  import('./pages/CustomFields').then((m) => ({ default: m.CustomFieldsPage })),
);
const AuditPage = lazy(() => import('./pages/Audit').then((m) => ({ default: m.AuditPage })));
const WebhooksPage = lazy(() =>
  import('./pages/Webhooks').then((m) => ({ default: m.WebhooksPage })),
);

function Loading() {
  return (
    <main className="flex min-h-screen items-center justify-center text-sm text-muted-fg">
      Carregando…
    </main>
  );
}

function Protected({ children }: { children: React.ReactNode }) {
  const { data: user, isLoading } = useSession();
  if (isLoading) return <Loading />;
  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

export function App() {
  return (
    // verticais entram só pela raiz de composição (ADR-047 E5, adendo 4)
    <NavContributionsProvider value={useVerticalNavGroups}>
      <Suspense fallback={<Loading />}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route
            element={
              <Protected>
                <AppShell />
              </Protected>
            }
          >
            {/*
            `/` era um redirect para o board: entrar no produto caía direto numa
            tabela, e a visão executiva do §1 do DESIGN_DIRECTION não existia em
            lugar nenhum. Hoje é a raiz e NÃO é lazy — é a primeira tela depois
            do login, e um chunk a mais ali seria um branco desnecessário.
          */}
            <Route path="/" element={<TodayPage />} />
            <Route path="/pipeline" element={<PipelinePage />} />
            <Route path="/contacts" element={<ContactsPage />} />
            <Route path="/companies" element={<CompaniesPage />} />
            <Route path="/inbox" element={<InboxPage />} />
            <Route path="/calendar" element={<CalendarPage />} />
            <Route path="/signals" element={<SignalsPage />} />
            <Route path="/settings/usage" element={<UsagePage />} />
            <Route path="/settings/automations" element={<AutomationsPage />} />
            <Route path="/tasks" element={<TasksPage />} />
            <Route path="/tags" element={<TagsPage />} />
            <Route path="/settings/fields" element={<CustomFieldsPage />} />
            <Route path="/settings/webhooks" element={<WebhooksPage />} />
            <Route path="/audit" element={<AuditPage />} />
            {VERTICAL_ROUTES.map((route) => (
              <Route key={route.path} path={route.path} element={route.element} />
            ))}
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </NavContributionsProvider>
  );
}
