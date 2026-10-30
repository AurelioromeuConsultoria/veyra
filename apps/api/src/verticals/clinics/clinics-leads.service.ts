import { Injectable } from '@nestjs/common';
import type {
  ClinicsLeadDto,
  ClinicsLeadsPageDto,
  ListClinicsLeadsInput,
} from '@veyra/contracts/verticals/clinics';
import { PrismaService } from '../../prisma/prisma.service';
import { decodeCursor, depoisDoCursor, encodeCursor } from './cursor-keyset';

type LeadRow = { id: string; name: string; createdAt: Date };

/**
 * Interessados (E-3 do ADR-055, adendos 3 e 4): os contatos ativos do
 * workspace SEM ficha de paciente, do mais recente para o mais antigo,
 * paginados no servidor por cursor. Só LEITURA do contato do Core, pelo client
 * protegido e pela relação reversa que o Core já declara — sem porta genérica
 * "com ou sem extensão" (D-E3.1). A rota exige `contacts:read` E
 * `clinics:schedule:read`: a lista é o complemento da de pacientes.
 */
@Injectable()
export class ClinicsLeadsService {
  constructor(private readonly prisma: PrismaService) {}

  async list({
    search,
    limit,
    cursor: bruto,
  }: ListClinicsLeadsInput): Promise<ClinicsLeadsPageDto> {
    const cursor = bruto ? decodeCursor(bruto) : null;
    const rows = (await this.prisma.db.contact.findMany({
      where: {
        status: 'active',
        clinicsPatient: { is: null },
        ...(search ? { name: { contains: search, mode: 'insensitive' } } : {}),
        ...depoisDoCursor(cursor),
      },
      select: { id: true, name: true, createdAt: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    } as never)) as unknown as LeadRow[];
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map(toDto),
      nextCursor:
        rows.length > limit && last
          ? encodeCursor({ createdAt: last.createdAt, id: last.id })
          : null,
    };
  }
}

function toDto(row: LeadRow): ClinicsLeadDto {
  return { id: row.id, name: row.name, createdAt: row.createdAt.toISOString() };
}
