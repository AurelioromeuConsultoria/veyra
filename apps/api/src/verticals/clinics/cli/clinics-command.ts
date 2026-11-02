import type {
  ClinicsActivationService,
  DivergenciaDePapel,
  RolesSyncReport,
} from '../clinics-activation.service';

export const CLINICS_USAGE = 'Uso: clinics <enable|disable|sync-roles> --slug slug-do-workspace';

/** As linhas para o operador e se o comando RECUSOU (a CLI sai com código 1). */
export interface ResultadoDoComando {
  linhas: string[];
  recusado: boolean;
}

export interface ClinicsCommand {
  command: 'enable' | 'disable' | 'sync-roles';
  slug: string;
}

const COMANDOS: readonly ClinicsCommand['command'][] = ['enable', 'disable', 'sync-roles'];

/** `argv` SEM `node` e o script: `['enable', '--slug', 'acme']`. `null` = uso inválido. */
export function parseClinicsArgs(argv: readonly string[]): ClinicsCommand | null {
  const [command] = argv;
  if (!COMANDOS.includes(command as ClinicsCommand['command'])) return null;
  const index = argv.indexOf('--slug');
  const slug = index >= 0 ? argv[index + 1] : undefined;
  if (!slug || slug.startsWith('--')) return null;
  return { command: command as ClinicsCommand['command'], slug };
}

function divergencia(d: DivergenciaDePapel): string {
  const papel = `${d.systemKey}`;
  switch (d.tipo) {
    case 'nome_em_uso':
      return `DIVERGÊNCIA (não corrigida, para decisão): o papel ${papel} não existe, e o nome "${d.nome}" já é de outro papel (${d.deChave ?? 'personalizado'}). Nada foi criado.`;
    case 'nome_diferente':
      return `DIVERGÊNCIA (não corrigida, para decisão): o papel ${papel} se chama "${d.nome}" (o padrão é "${d.esperado}").`;
    case 'chaves_a_menos':
      return `DIVERGÊNCIA (não corrigida, para decisão): o papel ${papel} ("${d.nome}") não tem, da matriz padrão: ${d.chaves.join(', ')}.`;
    case 'chaves_a_mais':
      return `DIVERGÊNCIA (não corrigida, para decisão): o papel ${papel} ("${d.nome}") tem, fora da matriz padrão: ${d.chaves.join(', ')}.`;
  }
}

/**
 * Corpo da CLI de ativação (ADR-047 §4), separado do ponto de entrada para que
 * o teste de integração rode o MESMO código: o `clinics.ts` só sobe o contexto
 * do Nest, chama isto e imprime as linhas.
 */
export async function runClinicsCommand(
  service: ClinicsActivationService,
  comando: ClinicsCommand,
): Promise<ResultadoDoComando> {
  const { command, slug } = comando;
  if (command === 'sync-roles') {
    const report = await service.syncRoles(slug);
    // a sincronização num workspace sem o Clinics ativo é RECUSA, e não um
    // "nada mudou": decidida pelo RESULTADO, e não pelo texto da linha
    if (report.outcome === 'clinics_inactive') {
      return {
        linhas: [
          `O Clinics não está ativo em ${slug}: nada foi criado. A sincronização só cria papéis de um vertical ativo.`,
        ],
        recusado: true,
      };
    }
    return { linhas: linhasDaSincronizacao(slug, report), recusado: false };
  }
  return { linhas: await linhasDaAtivacao(service, comando), recusado: false };
}

function linhasDaSincronizacao(slug: string, report: RolesSyncReport): string[] {
  const lines = report.criados.length
    ? report.criados.map(
        (c) =>
          `Papel criado em ${slug}: "${c.nome}" (${c.systemKey}), com a matriz padrão e SEM nenhum membro. Atribuir é pela tela de Equipe.`,
      )
    : [`Nenhum papel do Clinics ausente em ${slug}: nada foi criado.`];
  lines.push(...report.divergencias.map(divergencia));
  if (report.divergencias.length === 0) lines.push('Sem divergência com a matriz padrão.');
  return lines;
}

async function linhasDaAtivacao(
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
      ? `Clinics ATIVADO em ${slug}: papéis Profissional e Recepção e atendimento criados, permissões concedidas por systemKey, unidade inicial criada.`
      : `Clinics REATIVADO em ${slug}: permissões concedidas de novo aos papéis de sistema; liberações de IA voltam a valer.`,
    'Todo contato deste workspace passa a ser restrito: a IA não usa o conteúdo deles (salvo liberação explícita) e nenhum evento de contato sai por webhook.',
  ];
  // na reativação, o papel do vertical que faltava foi criado agora (ADR-056)
  if (report.outcome === 'reenabled') {
    for (const c of report.papeisCriados) {
      lines.push(
        `Papel criado na reativação: "${c.nome}" (${c.systemKey}), com a matriz padrão e SEM nenhum membro.`,
      );
    }
  }
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
