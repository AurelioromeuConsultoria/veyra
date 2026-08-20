import { Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from './components/layout/AppShell';
import { useSession } from './lib/session';
import { CompaniesPage } from './pages/Companies';
import { ContactsPage } from './pages/Contacts';
import { CustomFieldsPage } from './pages/CustomFields';
import { LoginPage } from './pages/Login';
import { TagsPage } from './pages/Tags';

function Protected({ children }: { children: React.ReactNode }) {
  const { data: user, isLoading } = useSession();
  if (isLoading) {
    return (
      <main className="flex min-h-screen items-center justify-center text-sm text-muted-fg">
        Carregando…
      </main>
    );
  }
  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        element={
          <Protected>
            <AppShell />
          </Protected>
        }
      >
        <Route path="/" element={<Navigate to="/contacts" replace />} />
        <Route path="/contacts" element={<ContactsPage />} />
        <Route path="/companies" element={<CompaniesPage />} />
        <Route path="/tags" element={<TagsPage />} />
        <Route path="/settings/fields" element={<CustomFieldsPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
