import { lazy } from 'react';
import type { VerticalRoute } from '../lib/nav';
import { TodayPage } from '../pages/Today';

/**
 * As telas do Core, por nome, para os manifestos escolherem (ADR-055, adendo
 * 2). Um produto monta só as que declara; nenhuma existe fora dele.
 *
 * Code-splitting por rota: o chunk inicial carrega só login + shell; kanban,
 * tabelas e timeline chegam sob demanda. O Hoje do CRM NÃO é lazy — é a
 * primeira tela depois do login, e um chunk a mais ali seria um branco.
 */
const ContactsPage = lazy(() =>
  import('../pages/Contacts').then((m) => ({ default: m.ContactsPage })),
);
const CompaniesPage = lazy(() =>
  import('../pages/Companies').then((m) => ({ default: m.CompaniesPage })),
);
const PipelinePage = lazy(() =>
  import('../pages/Pipeline').then((m) => ({ default: m.PipelinePage })),
);
const CalendarPage = lazy(() =>
  import('../pages/Calendar').then((m) => ({ default: m.CalendarPage })),
);
const AutomationsPage = lazy(() =>
  import('../pages/Automations').then((m) => ({ default: m.AutomationsPage })),
);
const UsagePage = lazy(() => import('../pages/Usage').then((m) => ({ default: m.UsagePage })));
const SignalsPage = lazy(() =>
  import('../pages/Signals').then((m) => ({ default: m.SignalsPage })),
);
const InboxPage = lazy(() => import('../pages/Inbox').then((m) => ({ default: m.InboxPage })));
const TasksPage = lazy(() => import('../pages/Tasks').then((m) => ({ default: m.TasksPage })));
const TagsPage = lazy(() => import('../pages/Tags').then((m) => ({ default: m.TagsPage })));
const CustomFieldsPage = lazy(() =>
  import('../pages/CustomFields').then((m) => ({ default: m.CustomFieldsPage })),
);
const AuditPage = lazy(() => import('../pages/Audit').then((m) => ({ default: m.AuditPage })));
const WebhooksPage = lazy(() =>
  import('../pages/Webhooks').then((m) => ({ default: m.WebhooksPage })),
);
const TeamPage = lazy(() => import('../pages/Team').then((m) => ({ default: m.TeamPage })));
const SettingsPage = lazy(() =>
  import('../pages/Settings').then((m) => ({ default: m.SettingsPage })),
);

export const ROTAS_DO_CORE = {
  hoje: { path: '/', element: <TodayPage /> },
  pipeline: { path: '/pipeline', element: <PipelinePage /> },
  contatos: { path: '/contacts', element: <ContactsPage /> },
  empresas: { path: '/companies', element: <CompaniesPage /> },
  inbox: { path: '/inbox', element: <InboxPage /> },
  agenda: { path: '/calendar', element: <CalendarPage /> },
  sinais: { path: '/signals', element: <SignalsPage /> },
  tarefas: { path: '/tasks', element: <TasksPage /> },
  tags: { path: '/tags', element: <TagsPage /> },
  campos: { path: '/settings/fields', element: <CustomFieldsPage /> },
  automacoes: { path: '/settings/automations', element: <AutomationsPage /> },
  webhooks: { path: '/settings/webhooks', element: <WebhooksPage /> },
  uso: { path: '/settings/usage', element: <UsagePage /> },
  auditoria: { path: '/audit', element: <AuditPage /> },
  equipe: { path: '/settings/team', element: <TeamPage /> },
  configuracoes: { path: '/settings', element: <SettingsPage /> },
} satisfies Record<string, VerticalRoute>;

export type RotaDoCore = keyof typeof ROTAS_DO_CORE;

export function rotasDoCore(...nomes: RotaDoCore[]): VerticalRoute[] {
  return nomes.map((nome) => ROTAS_DO_CORE[nome]);
}
