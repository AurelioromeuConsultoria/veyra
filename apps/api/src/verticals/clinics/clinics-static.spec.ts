import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  CLINICS_PERMISSION_CATALOG,
  CLINICS_PROFESSIONAL_SYSTEM_KEY,
  clinicsAiReleaseReasonSchema,
  clinicsAppointmentStatusSchema,
  clinicsCancelReasonSchema,
} from '@veyra/contracts/verticals/clinics';
import {
  ClinicsAppointmentStatus,
  ClinicsCancelReason,
  ClinicsReleaseConsumer,
  ClinicsReleaseReason,
} from '../../generated/prisma/enums';
import { CLINICS_ROLE_GRANTS } from './clinics-permissions';
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

  // Garantia PARCIAL nos imports: o `ContactsService` (que publica no outbox) é
  // importado legitimamente desde a F2.1, para ler e travar contatos. Para a
  // agenda, quem prova a fronteira é o teste de integração que conta os eventos.
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

  it('a matriz só concede chaves do catálogo do vertical, e Guest não recebe nada', () => {
    const catalogo = new Set(Object.keys(CLINICS_PERMISSION_CATALOG));
    for (const keys of Object.values(CLINICS_ROLE_GRANTS)) {
      for (const key of keys) expect(catalogo.has(key)).toBe(true);
    }
    expect(Object.keys(CLINICS_ROLE_GRANTS).sort()).toEqual(
      ['admin', 'member', 'owner', CLINICS_PROFESSIONAL_SYSTEM_KEY].sort(),
    );
    // recepção (Member) sem atendimento; Profissional sem escrita de agenda
    expect(CLINICS_ROLE_GRANTS.member.some((k) => k.startsWith('clinics:care'))).toBe(false);
    expect(CLINICS_ROLE_GRANTS[CLINICS_PROFESSIONAL_SYSTEM_KEY]).not.toContain(
      'clinics:schedule:write',
    );
  });
});
