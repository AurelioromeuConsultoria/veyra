import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { SYSTEM_ROLE_TEMPLATES } from '@veyra/contracts';
import {
  CLINICS_PERMISSION_CATALOG,
  CLINICS_PROFESSIONAL_SYSTEM_KEY,
  CLINICS_RECEPTION_CARE_SYSTEM_KEY,
  clinicsAiReleaseReasonSchema,
  clinicsAppointmentStatusSchema,
  clinicsCancelReasonSchema,
  CLINICS_RETURN_CANCEL_REASONS,
  CLINICS_RETURN_STATUSES,
} from '@veyra/contracts/verticals/clinics';
import {
  ClinicsAppointmentStatus,
  ClinicsCancelReason,
  ClinicsReturnCancelReason,
  ClinicsReturnStatus,
  ClinicsReleaseConsumer,
  ClinicsReleaseReason,
} from '../../generated/prisma/enums';
import {
  CLINICS_RECEPTION_CARE_CORE_KEYS,
  CLINICS_ROLE_GRANTS,
  CLINICS_VERTICAL_ROLES,
  chavesPadraoDoPapel,
} from './clinics-permissions';
import { CLINICS_MODELS, clinicsExtension } from './clinics.extension';

const ROOT = __dirname;
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return /\.ts$/.test(entry) && !/\.(spec|integration-spec)\.ts$/.test(entry) ? [full] : [];
  });

describe('Clinics — garantias estáticas (ADR-047, ADR-048)', () => {
  it('só o serviço de ATIVAÇÃO escreve RolePermission no vertical', () => {
    const WRITES = [
      /rolePermission\s*\.\s*(create|createMany|createManyAndReturn|update|updateMany|upsert|delete|deleteMany)\b/,
      /(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+"?RolePermission"?/i,
      /\b(permissions|rolePermissions)\s*:\s*\{\s*(create|createMany|connect|connectOrCreate|upsert)\b/,
    ];
    const escritores = walk(ROOT)
      .filter((file) => WRITES.some((p) => p.test(readFileSync(file, 'utf8'))))
      .map((file) => relative(ROOT, file));
    expect(escritores).toEqual(['clinics-activation.service.ts']);
  });

  it('nenhum comando, rota ou job do vertical apaga ClinicsSettings (a presença depende dela)', () => {
    const APAGA = [
      /clinicsSettings\s*\.\s*(delete|deleteMany)\b/,
      /(DELETE\s+FROM|TRUNCATE)\s+(TABLE\s+)?"?ClinicsSettings"?/i,
    ];
    const apagadores = walk(ROOT)
      .filter((file) => APAGA.some((p) => p.test(readFileSync(file, 'utf8'))))
      .map((file) => relative(ROOT, file));
    expect(apagadores).toEqual([]);
  });

  it('a PRESENÇA cobre todo modelo do vertical (lista única, a mesma do registro e do schema)', () => {
    const schema = readFileSync(join(ROOT, '../../../prisma/schema/clinics.prisma'), 'utf8');
    const doSchema = [...schema.matchAll(/^model\s+(\w+)\s+\{/gm)].map((m) => m[1]).sort();
    expect([...CLINICS_MODELS].sort()).toEqual(doSchema);
    expect([...(clinicsExtension.tenantModels?.workspaceModels ?? [])].sort()).toEqual(doSchema);
  });

  it('motivos e consumidores: contrato (Zod) e banco (enum) são a MESMA lista', () => {
    // motivo só no Zod viraria 500 na gravação; só no banco, um valor que a API nunca aceita
    expect([...clinicsAiReleaseReasonSchema.options].sort()).toEqual(
      Object.values(ClinicsReleaseReason).sort(),
    );
    // no MVP só `ai` tem liberação (ADR-048 §6.4); webhook nunca
    expect(Object.values(ClinicsReleaseConsumer)).toEqual(['ai']);
  });

  it('estados e motivos de cancelamento da agenda: contrato (Zod) e banco (enum) são a MESMA lista', () => {
    expect([...clinicsAppointmentStatusSchema.options].sort()).toEqual(
      Object.values(ClinicsAppointmentStatus).sort(),
    );
    expect([...clinicsCancelReasonSchema.options].sort()).toEqual(
      Object.values(ClinicsCancelReason).sort(),
    );
  });

  it('estados e motivos de encerramento do RETORNO: contrato e banco (enum) são a MESMA lista (F3.2)', () => {
    expect([...CLINICS_RETURN_STATUSES].sort()).toEqual(Object.values(ClinicsReturnStatus).sort());
    expect([...CLINICS_RETURN_CANCEL_REASONS].sort()).toEqual(
      Object.values(ClinicsReturnCancelReason).sort(),
    );
  });

  // Garantia PARCIAL nos imports: o `ContactsService` (que publica no outbox) é
  // importado legitimamente desde a F2.1, para ler e travar contatos; desde a
  // F4.4c, também pela carga da demonstração, que CRIA contato fictício (a
  // exceção do teste seguinte). Para a agenda, quem prova a fronteira é o teste
  // de integração que conta os eventos.
  it('o vertical NÃO escreve em entidades do Core nem no outbox, e não importa os serviços de tarefa, atividade, notificação, webhook, deal, conversa e canal (adendo 2, item 7)', () => {
    // dado classe S não pode ir parar em tarefa, atividade, nota, notificação,
    // deal, conversa, mensagem ou evento — nem por escrita direta, nem por serviço
    const ESCRITA_NO_CORE =
      /\b(task|activity|note|notification|outboxEvent|deal|contact|conversation|message|messageDispatch|webhook)\s*\.\s*(create|createMany|createManyAndReturn|update|updateMany|updateManyAndReturn|upsert|delete|deleteMany)\b/;
    const SERVICOS_QUE_PUBLICAM =
      /from '\.\.\/(\.\.\/)+(outbox|tasks|activities|notifications|webhooks|deals|conversations|channels)\//;
    const ofensas = walk(ROOT)
      .filter((file) => {
        const texto = readFileSync(file, 'utf8');
        return ESCRITA_NO_CORE.test(texto) || SERVICOS_QUE_PUBLICAM.test(texto);
      })
      .map((file) => relative(ROOT, file));
    expect(ofensas).toEqual([]);
  });

  it('a ÚNICA escrita de contato do vertical no Core: a carga da demonstração, com dados fictícios (F4.4c, ADR-048 adendo 13)', () => {
    // lista FECHADA: quem importa o serviço de contatos do Core, e o que chama
    // nele. Só leitura (`get`), menos a carga da demonstração, que cria contato
    // fictício (grava a entidade e publica no outbox)
    const IMPORTA = /from '(\.\.\/)+contacts\/contacts\.service'/;
    const CHAMADA = /(ContactsService\)|this\.contacts\w*|this\.contatos\w*)\s*\.\s*(\w+)\s*\(/g;
    const PERMITIDO: Record<string, string[]> = {
      'cli/demo-carregar.core.ts': ['create'],
      'clinics-patients.service.ts': ['get'],
      'clinics-releases.service.ts': ['get'],
    };
    const quem = walk(ROOT)
      .filter((file) => IMPORTA.test(readFileSync(file, 'utf8')))
      .map((file) => relative(ROOT, file))
      .sort();
    expect(quem).toEqual(Object.keys(PERMITIDO).sort());
    for (const arquivo of quem) {
      const metodos = [...readFileSync(join(ROOT, arquivo), 'utf8').matchAll(CHAMADA)].map(
        (m) => m[2],
      );
      expect(metodos.length).toBeGreaterThan(0);
      expect({ arquivo, fora: metodos.filter((m) => !PERMITIDO[arquivo].includes(m)) }).toEqual({
        arquivo,
        fora: [],
      });
    }
  });

  it('a ÚNICA exceção à fronteira de escrita no Core: o envio do negócio, só pelos arquivos do pedido de envio (F4.2)', () => {
    // a aprovação pelo serviço do Core cria conversa, mensagem, despacho e o
    // evento do outbox — é o caminho DESENHADO (ADR-048 adendo 9), com as
    // travas, a guarda e a trilha do Core; nenhum outro arquivo do vertical o usa
    const quem = walk(ROOT)
      .filter((file) => /from '\.\.\/(\.\.\/)+business-outbound\//.test(readFileSync(file, 'utf8')))
      .map((file) => relative(ROOT, file))
      .sort();
    expect(quem).toEqual([
      // o módulo, para a injeção
      'clinics.module.ts',
      // as métricas leem a situação e o desfecho das origens (F4.3)
      'commercial/clinics-outreach-metrics.service.ts',
      'outreach/clinics-outreach.service.ts',
      'outreach/clinics-outreach.sweep.ts',
      'outreach/clinics-outreach.validity.ts',
    ]);
  });

  it('o único `raw` do pedido de envio é a lista dos workspaces da varredura (F4.2, CLAUDE.md §3.3)', () => {
    const usam = walk(join(ROOT, 'outreach'))
      .filter((file) => /\.raw\b/.test(readFileSync(file, 'utf8')))
      .map((file) => relative(ROOT, file));
    expect(usam).toEqual(['outreach/clinics-outreach.sweep.ts']);
    const varredura = readFileSync(join(ROOT, 'outreach/clinics-outreach.sweep.ts'), 'utf8');
    expect(varredura.match(/\.raw\b/g)).toHaveLength(1);
    // só agrupa por workspace: nenhum pedido, texto ou escrita sai pelo `raw`
    expect(varredura).toMatch(
      /\.raw\.clinicsOutreachRequest\.groupBy\(\{\s*by: \['workspaceId'\],/,
    );
  });

  it('a matriz só concede chaves do catálogo do vertical, e Guest não recebe nada', () => {
    const catalogo = new Set(Object.keys(CLINICS_PERMISSION_CATALOG));
    for (const keys of Object.values(CLINICS_ROLE_GRANTS)) {
      for (const key of keys) expect(catalogo.has(key)).toBe(true);
    }
    expect(Object.keys(CLINICS_ROLE_GRANTS).sort()).toEqual(
      [
        'admin',
        'member',
        'owner',
        CLINICS_PROFESSIONAL_SYSTEM_KEY,
        CLINICS_RECEPTION_CARE_SYSTEM_KEY,
      ].sort(),
    );
    // recepção (Member) sem atendimento; Profissional sem escrita de agenda
    expect(CLINICS_ROLE_GRANTS.member.some((k) => k.startsWith('clinics:care'))).toBe(false);
    expect(CLINICS_ROLE_GRANTS[CLINICS_PROFESSIONAL_SYSTEM_KEY]).not.toContain(
      'clinics:schedule:write',
    );
  });

  it('"Recepção e atendimento" (ADR-056): a matriz PADRÃO exata, fixada aqui, com as ausências exigidas', () => {
    // a lista é LITERAL de propósito: mudar o Member padrão ou a matriz do
    // vertical quebra este teste, e a mudança vira decisão explícita
    const papel = CLINICS_VERTICAL_ROLES.find(
      (p) => p.systemKey === CLINICS_RECEPTION_CARE_SYSTEM_KEY,
    );
    expect(papel).toMatchObject({ name: 'Recepção e atendimento' });
    expect(chavesPadraoDoPapel(papel!)).toEqual(
      [
        'workspace:read',
        'members:read',
        'contacts:read',
        'contacts:write',
        'pipelines:read',
        'deals:write',
        'tasks:read',
        'tasks:write',
        'conversations:read',
        'conversations:write',
        'calendar:read',
        'calendar:write',
        'files:read',
        'files:write',
        'intelligence:use',
        'consents:read',
        'consents:manage',
        'clinics:catalog:read',
        'clinics:schedule:read',
        'clinics:schedule:write',
        'clinics:care:read',
        'clinics:care:write',
        // o alcance de todos os atendimentos (ADR-061, D8)
        'clinics:care:all',
        // as notas e tarefas de pacientes (ADR-061, adendo 2)
        'clinics:patient-content:read',
        // consultar e registrar pagamentos de pacotes, sem anular (ADR-063 adendo 1)
        'clinics:payments:read',
        'clinics:payments:write',
      ].sort(),
    );
    // anular pagamento é SÓ de Owner e Admin (ADR-063 adendo 1)
    for (const k of [
      CLINICS_RECEPTION_CARE_SYSTEM_KEY,
      'member',
      CLINICS_PROFESSIONAL_SYSTEM_KEY,
    ]) {
      expect(CLINICS_ROLE_GRANTS[k]).not.toContain('clinics:payments:void');
    }
    expect(CLINICS_ROLE_GRANTS[CLINICS_PROFESSIONAL_SYSTEM_KEY]).not.toContain(
      'clinics:payments:read',
    );
    // a soma da recepção e do atendimento PADRÃO do vertical, mais o alcance "todos"
    expect([...CLINICS_ROLE_GRANTS[CLINICS_RECEPTION_CARE_SYSTEM_KEY]].sort()).toEqual(
      [
        ...new Set([
          ...CLINICS_ROLE_GRANTS.member,
          ...CLINICS_ROLE_GRANTS[CLINICS_PROFESSIONAL_SYSTEM_KEY],
          'clinics:care:all',
          'clinics:patient-content:read',
        ]),
      ].sort(),
    );
    // o Profissional e a recepção NÃO têm o alcance "todos" (D8)
    expect(CLINICS_ROLE_GRANTS[CLINICS_PROFESSIONAL_SYSTEM_KEY]).not.toContain('clinics:care:all');
    expect(CLINICS_ROLE_GRANTS.member).not.toContain('clinics:care:all');
    // a recepção e o Profissional NÃO leem notas e tarefas de pacientes (ADR-061, adendo 2)
    for (const k of [CLINICS_PROFESSIONAL_SYSTEM_KEY, 'member']) {
      expect(CLINICS_ROLE_GRANTS[k]).not.toContain('clinics:patient-content:read');
    }
    // sem a gestão de equipe e de papéis, sem a liberação para IA e sem a auditoria
    for (const ausente of [
      'members:manage',
      'roles:manage',
      'workspace:manage',
      'audit:read',
      'billing:manage',
      'webhooks:manage',
      'automations:manage',
      'intelligence:approve',
      'consents:unblock',
      'templates:review',
      'clinics:catalog:manage',
      'clinics:restriction:manage',
    ]) {
      expect(chavesPadraoDoPapel(papel!)).not.toContain(ausente);
    }
    // as do Core são as do TEMPLATE documentado do Member, não as de um papel do workspace
    expect([...CLINICS_RECEPTION_CARE_CORE_KEYS].sort()).toEqual(
      [...SYSTEM_ROLE_TEMPLATES.Member].sort(),
    );
  });

  it('"Atendimento e conversas" fica PROPOSTO (ADR-056): não é criado nem atribuível', () => {
    expect(CLINICS_VERTICAL_ROLES.map((p) => p.systemKey).sort()).toEqual(
      [CLINICS_PROFESSIONAL_SYSTEM_KEY, CLINICS_RECEPTION_CARE_SYSTEM_KEY].sort(),
    );
    expect(Object.keys(CLINICS_ROLE_GRANTS).some((k) => /convers/.test(k))).toBe(false);
  });

  it('todo papel do vertical tem a forma `clinics:<papel>` e ao menos uma chave do Clinics na matriz: só assim o Core o atribui com o vertical ativo (ADR-056 adendo 1)', () => {
    for (const papel of CLINICS_VERTICAL_ROLES) {
      expect(papel.systemKey).toMatch(/^clinics:[a-z-]+$/);
      expect(
        (CLINICS_ROLE_GRANTS[papel.systemKey] ?? []).filter((k) => k.startsWith('clinics:')),
      ).not.toHaveLength(0);
    }
  });

  it('na matriz, quem ESCREVE atendimento também o LÊ (care:write pressupõe care:read, ADR-048 adendo 7)', () => {
    for (const keys of Object.values(CLINICS_ROLE_GRANTS)) {
      if (keys.includes('clinics:care:write')) expect(keys).toContain('clinics:care:read');
    }
  });

  it('o CONTADOR do pacote só tem três escritores: o registro de atendimento (consumo e vínculo), o serviço de pacotes (criação e cancelamento) e a correção de consumo (ADR-059); o atendimento, só o registro', () => {
    // escritas no pacote e no atendimento (o vínculo nasce com o atendimento)
    const ESCREVE_PACOTE = [
      /clinicsPackage\s*\.\s*(create|createMany|createManyAndReturn|update|updateMany|upsert|delete|deleteMany)\b/,
      /(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+"?ClinicsPackage"?/i,
    ];
    const ESCREVE_ATENDIMENTO = [
      /clinicsAttendance\s*\.\s*(create|createMany|createManyAndReturn|update|updateMany|upsert|delete|deleteMany)\b/,
      /(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+"?ClinicsAttendance"?/i,
    ];
    const quem = (padroes: RegExp[]) =>
      walk(ROOT)
        .filter((file) => padroes.some((p) => p.test(readFileSync(file, 'utf8'))))
        .map((file) => relative(ROOT, file))
        .sort();
    expect(quem(ESCREVE_PACOTE)).toEqual([
      'care/clinics-package-corrections.service.ts',
      'care/clinics-packages.service.ts',
      'schedule/clinics-attendance.service.ts',
    ]);
    // o consumo vigente e a revisão mudam pelo GATILHO da correção, nunca pelo
    // código: a correção não escreve no atendimento
    expect(quem(ESCREVE_ATENDIMENTO)).toEqual(['schedule/clinics-attendance.service.ts']);
  });

  it('a CORREÇÃO de consumo só tem um escritor, e só cria uma a uma: nenhuma criação em lote, alteração nem exclusão em lugar nenhum (ADR-059)', () => {
    const CRIA = /clinicsPackageCorrection\s*\.\s*create\b/;
    const ALTERA = [
      /clinicsPackageCorrection\s*\.\s*(createMany|createManyAndReturn|update|updateMany|upsert|delete|deleteMany)\b/,
      /(UPDATE|DELETE\s+FROM)\s+"?ClinicsPackageCorrection"?/i,
    ];
    const arquivos = walk(ROOT);
    expect(
      arquivos
        .filter((file) => CRIA.test(readFileSync(file, 'utf8')))
        .map((file) => relative(ROOT, file))
        .sort(),
    ).toEqual(['care/clinics-package-corrections.service.ts']);
    expect(
      arquivos.filter((file) => ALTERA.some((p) => p.test(readFileSync(file, 'utf8')))),
    ).toEqual([]);
  });

  it('o PAGAMENTO e a ANULAÇÃO só têm um escritor, e só criam um a um: nenhuma criação em lote, alteração nem exclusão (ADR-063)', () => {
    const CRIA = /clinicsPackagePayment(Void)?\s*\.\s*create\b/;
    const ALTERA = [
      /clinicsPackagePayment(Void)?\s*\.\s*(createMany|createManyAndReturn|update|updateMany|upsert|delete|deleteMany)\b/,
      /(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+"?ClinicsPackagePayment(Void)?"?/i,
    ];
    const arquivos = walk(ROOT);
    expect(
      arquivos
        .filter((file) => CRIA.test(readFileSync(file, 'utf8')))
        .map((file) => relative(ROOT, file))
        .sort(),
    ).toEqual(['care/clinics-package-payments.service.ts']);
    expect(
      arquivos.filter((file) => ALTERA.some((p) => p.test(readFileSync(file, 'utf8')))),
    ).toEqual([]);
  });

  it('o RETORNO só tem um arquivo escritor: o serviço de retornos (o registro de atendimento chama as funções dele, na sua transação) — F3.2', () => {
    const ESCREVE_RETORNO = [
      /clinicsReturn\s*\.\s*(create|createMany|createManyAndReturn|update|updateMany|upsert|delete|deleteMany)\b/,
      /(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+"?ClinicsReturn"?/i,
    ];
    const quem = walk(ROOT)
      .filter((file) => ESCREVE_RETORNO.some((p) => p.test(readFileSync(file, 'utf8'))))
      .map((file) => relative(ROOT, file))
      .sort();
    expect(quem).toEqual(['schedule/clinics-returns.service.ts']);
  });
});
