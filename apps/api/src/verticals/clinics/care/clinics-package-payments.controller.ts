import { Body, Controller, Get, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import {
  recordClinicsPackagePaymentSchema,
  voidClinicsPackagePaymentSchema,
  type ClinicsPackageBalanceDto,
  type ClinicsPackagePaymentDto,
  type ClinicsPackagePaymentsDto,
  type RecordClinicsPackagePaymentInput,
  type VoidClinicsPackagePaymentInput,
} from '@veyra/contracts/verticals/clinics';
import { AuthContext, CurrentAuth } from '../../../common/decorators';
import { Idempotent } from '../../../common/idempotency.decorator';
import { ZodPipe } from '../../../common/zod.pipe';
import { ClinicsActiveGuard } from '../clinics-active.guard';
import { RequireClinicsPermissions } from '../clinics-permissions';
import {
  ClinicsPaymentRecordReplayGuard,
  ClinicsPaymentVoidReplayGuard,
} from './clinics-package-payment-replay.guard';
import { ClinicsPackagePaymentsService } from './clinics-package-payments.service';

/**
 * Pagamentos de pacotes (ADR-063, F6.1a). Acesso PRÓPRIO, separado do
 * atendimento: `clinics:payments:*`, sem `care:*`. A visão financeira mostra o
 * pacote (serviço, estado, preço, recebido e saldo), sem sessões, atendimentos
 * nem correções. Toda rota exige também a leitura da agenda (o perfil do
 * paciente), o pré-requisito das chaves. Registrar e anular exigem
 * `Idempotency-Key` (sem ela, 400); o replay devolve o resultado original, com
 * o acesso de agora conferido pela guarda.
 */
@Controller('clinics')
@UseGuards(ClinicsActiveGuard)
export class ClinicsPackagePaymentsController {
  constructor(private readonly payments: ClinicsPackagePaymentsService) {}

  @RequireClinicsPermissions('clinics:payments:read', 'clinics:schedule:read')
  @Get('patients/:id/package-payments')
  balances(@Param('id', new ParseUUIDPipe()) id: string): Promise<ClinicsPackageBalanceDto[]> {
    return this.payments.balances(id);
  }

  @RequireClinicsPermissions('clinics:payments:read', 'clinics:schedule:read')
  @Get('packages/:id/payments')
  detail(@Param('id', new ParseUUIDPipe()) id: string): Promise<ClinicsPackagePaymentsDto> {
    return this.payments.detail(id);
  }

  // as chaves são as de REGISTRAR_PAGAMENTO, conferidas de novo no replay
  @RequireClinicsPermissions(
    'clinics:payments:write',
    'clinics:payments:read',
    'clinics:schedule:read',
  )
  @Idempotent({ required: true, replayGuard: ClinicsPaymentRecordReplayGuard })
  @Post('packages/:id/payments')
  record(
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodPipe(recordClinicsPackagePaymentSchema)) body: RecordClinicsPackagePaymentInput,
  ): Promise<ClinicsPackagePaymentDto> {
    return this.payments.record(auth, id, body);
  }

  // as chaves são as de ANULAR_PAGAMENTO, conferidas de novo no replay
  @RequireClinicsPermissions(
    'clinics:payments:void',
    'clinics:payments:read',
    'clinics:schedule:read',
  )
  @Idempotent({ required: true, replayGuard: ClinicsPaymentVoidReplayGuard })
  @Post('package-payments/:id/void')
  void(
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodPipe(voidClinicsPackagePaymentSchema)) body: VoidClinicsPackagePaymentInput,
  ): Promise<ClinicsPackagePaymentDto> {
    return this.payments.void(auth, id, body);
  }
}
