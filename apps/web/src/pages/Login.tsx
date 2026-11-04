import { zodResolver } from '@hookform/resolvers/zod';
import { loginSchema, type LoginInput } from '@veyra/contracts';
import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { Navigate } from 'react-router-dom';
import { Marca } from '../components/layout/Marca';
import { Button } from '../components/ui/button';
import { Field, Input } from '../components/ui/input';
import { ApiError } from '../lib/api';
import { useLogin, useSession } from '../lib/session';

export function LoginPage() {
  const { data: user, isLoading } = useSession();
  const login = useLogin();
  const form = useForm<LoginInput>({ resolver: zodResolver(loginSchema) });

  /** sair devolve a aba ao estado neutro; sem isto o título fica preso na
   *  última seção (e no nome do workspace de quem acabou de sair) */
  useEffect(() => {
    document.title = 'Entrar · Veyra';
  }, []);

  // o destino do login é a visão do dia, não uma tabela
  if (!isLoading && user) return <Navigate to="/" replace />;

  return (
    <main className="flex min-h-screen">
      <div className="flex flex-1 items-center justify-center px-6 py-12">
        <div className="w-full max-w-sm rise">
          <Marca nome="veyra" tom="dia" />

          <h1 className="mt-10 font-display text-[26px] font-semibold tracking-[-0.02em]">
            Entrar no workspace
          </h1>
          <p className="mt-1.5 text-[14px] text-muted-fg">Use o e-mail do seu convite.</p>
          <form
            className="mt-5 space-y-4"
            onSubmit={form.handleSubmit((values) => login.mutate(values))}
            noValidate
          >
            <Field label="E-mail" error={form.formState.errors.email?.message}>
              <Input type="email" autoComplete="email" autoFocus {...form.register('email')} />
            </Field>
            <Field label="Senha" error={form.formState.errors.password?.message}>
              <Input
                type="password"
                autoComplete="current-password"
                {...form.register('password')}
              />
            </Field>
            {login.error ? (
              <p role="alert" className="text-body-sm text-negative">
                {login.error instanceof ApiError ? login.error.message : 'Falha no login'}
              </p>
            ) : null}
            <Button
              type="submit"
              variant="primary"
              className="w-full"
              disabled={login.isPending}
              size="md"
            >
              {login.isPending ? 'Entrando…' : 'Entrar'}
            </Button>
          </form>
          <p className="mt-6 border-t border-border pt-4 text-data text-muted-fg">
            Sem conta? A entrada é por convite do seu workspace.
          </p>
        </div>
      </div>

      {/* o painel é a MOLDURA do app (ADR-062): o mesmo verde-abissal da lateral */}
      <aside className="relative hidden w-[46%] max-w-2xl flex-col justify-between bg-frame px-12 py-12 text-frame-fg lg:flex">
        <p className="text-[12px] font-semibold uppercase tracking-[0.06em] text-frame-label">
          Núcleo de relacionamento
        </p>
        <div className="max-w-md">
          <p className="font-display text-[34px] font-semibold leading-[1.15] tracking-[-0.02em] text-white">
            O trabalho do dia — contatos, conversas e próximas ações — num lugar só.
          </p>
          <p className="mt-4 text-[15px] text-frame-muted">
            A inteligência aparece como sinal, sugestão e próxima ação. Nada sai sem uma decisão
            humana.
          </p>
        </div>
        <dl className="flex gap-10">
          {[
            ['Isolamento', 'por workspace'],
            ['Permissões', 'default-deny'],
            ['Auditoria', 'de ponta a ponta'],
          ].map(([term, detail]) => (
            <div key={term}>
              <dt className="text-[12px] font-semibold uppercase tracking-[0.06em] text-frame-label">
                {term}
              </dt>
              <dd className="mt-1 text-[14px] text-white">{detail}</dd>
            </div>
          ))}
        </dl>
      </aside>
    </main>
  );
}
