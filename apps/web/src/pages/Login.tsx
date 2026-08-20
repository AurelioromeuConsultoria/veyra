import { zodResolver } from '@hookform/resolvers/zod';
import { loginSchema, type LoginInput } from '@veyra/contracts';
import { useForm } from 'react-hook-form';
import { Navigate } from 'react-router-dom';
import { Button } from '../components/ui/button';
import { Field, Input } from '../components/ui/input';
import { ApiError } from '../lib/api';
import { useLogin, useSession } from '../lib/session';

export function LoginPage() {
  const { data: user, isLoading } = useSession();
  const login = useLogin();
  const form = useForm<LoginInput>({ resolver: zodResolver(loginSchema) });

  if (!isLoading && user) return <Navigate to="/contacts" replace />;

  return (
    <main className="flex min-h-screen items-center justify-center px-6">
      <div className="w-full max-w-sm">
        <p className="text-xs font-medium uppercase tracking-widest text-muted-fg">CRM Core</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight text-accent">veyra</h1>
        <form
          className="mt-8 space-y-4"
          onSubmit={form.handleSubmit((values) => login.mutate(values))}
          noValidate
        >
          <Field label="E-mail" error={form.formState.errors.email?.message}>
            <Input type="email" autoComplete="email" autoFocus {...form.register('email')} />
          </Field>
          <Field label="Senha" error={form.formState.errors.password?.message}>
            <Input type="password" autoComplete="current-password" {...form.register('password')} />
          </Field>
          {login.error ? (
            <p role="alert" className="text-sm text-negative">
              {login.error instanceof ApiError ? login.error.message : 'Falha no login'}
            </p>
          ) : null}
          <Button type="submit" variant="primary" className="w-full" disabled={login.isPending}>
            {login.isPending ? 'Entrando…' : 'Entrar'}
          </Button>
        </form>
        <p className="mt-6 text-xs text-muted-fg">
          Sem conta? A entrada é por convite do seu workspace.
        </p>
      </div>
    </main>
  );
}
