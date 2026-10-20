import type { ClinicsActivationService } from '../clinics-activation.service';

export const CLINICS_USAGE = 'Uso: clinics <enable|disable> --slug slug-do-workspace';

export interface ClinicsCommand {
  command: 'enable' | 'disable';
  slug: string;
}

/** `argv` SEM `node` e o script: `['enable', '--slug', 'acme']`. `null` = uso inválido. */
export function parseClinicsArgs(argv: readonly string[]): ClinicsCommand | null {
  const [command] = argv;
  if (command !== 'enable' && command !== 'disable') return null;
  const index = argv.indexOf('--slug');
  const slug = index >= 0 ? argv[index + 1] : undefined;
  if (!slug || slug.startsWith('--')) return null;
  return { command, slug };
}

/**
 * Corpo da CLI de ativação (ADR-047 §4), separado do ponto de entrada para que
 * o teste de integração rode o MESMO código: o `clinics.ts` só sobe o contexto
 * do Nest, chama isto e imprime as linhas.
 */
export async function runClinicsCommand(
  service: ClinicsActivationService,
  { command, slug }: ClinicsCommand,
): Promise<string[]> {
  if (command === 'disable') {
    const { outcome, expiredContent } = await service.disable(slug);
    if (outcome !== 'disabled') return [`Clinics já não estava ativo em ${slug}: nada mudou.`];
    const lines = [
      `Clinics DESATIVADO em ${slug}: chaves clinics:* removidas de todos os papéis; os tokens de acesso emitidos antes deixam de valer. Nenhum dado apagado; a restrição de conteúdo continua valendo.`,
    ];
    if (expiredContent === null) {
      lines.push('Aviso: a limpeza do conteúdo de IA falhou; a leitura já o oculta.');
    }
    return lines;
  }
  const report = await service.enable(slug);
  if (report.outcome === 'already_active')
    return [`Clinics já estava ativo em ${slug}: nada mudou.`];
  const lines = [
    report.outcome === 'enabled'
      ? `Clinics ATIVADO em ${slug}: papel Profissional criado, permissões concedidas por systemKey, unidade inicial criada.`
      : `Clinics REATIVADO em ${slug}: permissões concedidas de novo aos papéis de sistema; liberações de IA voltam a valer.`,
    'Todo contato deste workspace passa a ser restrito: a IA não usa o conteúdo deles (salvo liberação explícita) e nenhum evento de contato sai por webhook.',
  ];
  if (report.activeWebhooks > 0) {
    lines.push(
      `ATENÇÃO: ${report.activeWebhooks} webhook(s) ativo(s) deixam de receber eventos de contato — inclusive EXCLUSÕES de contatos enviados a eles antes da ativação (propagação de exclusão LGPD fica a cargo da operação).`,
    );
  }
  if (report.expiredContent === null) {
    lines.push('Aviso: a limpeza do conteúdo de IA anterior falhou; a leitura já o oculta.');
  }
  return lines;
}
