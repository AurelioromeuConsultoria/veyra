import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  CompanyDto,
  CreateCompanyInput,
  ListCompaniesInput,
  Paginated,
  UpdateCompanyInput,
  createCompanySchema,
  listCompaniesSchema,
  updateCompanySchema,
} from '@veyra/contracts';
import { RequirePermissions } from '../common/decorators';
import { ZodPipe } from '../common/zod.pipe';
import { CompaniesService } from './companies.service';

@Controller('companies')
export class CompaniesController {
  constructor(private readonly companies: CompaniesService) {}

  @RequirePermissions('contacts:read')
  @Get()
  list(
    @Query(new ZodPipe(listCompaniesSchema)) query: ListCompaniesInput,
  ): Promise<Paginated<CompanyDto>> {
    return this.companies.list(query);
  }

  @RequirePermissions('contacts:read')
  @Get(':id')
  get(@Param('id', new ParseUUIDPipe()) id: string): Promise<CompanyDto> {
    return this.companies.get(id);
  }

  @RequirePermissions('contacts:write')
  @Post()
  create(@Body(new ZodPipe(createCompanySchema)) body: CreateCompanyInput): Promise<CompanyDto> {
    return this.companies.create(body);
  }

  @RequirePermissions('contacts:write')
  @Patch(':id')
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodPipe(updateCompanySchema)) body: UpdateCompanyInput,
  ): Promise<CompanyDto> {
    return this.companies.update(id, body);
  }

  @RequirePermissions('contacts:write')
  @Delete(':id')
  async remove(@Param('id', new ParseUUIDPipe()) id: string): Promise<{ ok: true }> {
    await this.companies.remove(id);
    return { ok: true };
  }
}
