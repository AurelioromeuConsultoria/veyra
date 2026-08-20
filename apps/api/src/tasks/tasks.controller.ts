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
  CreateTaskInput,
  ListTasksInput,
  Paginated,
  TaskDto,
  UpdateTaskInput,
  createTaskSchema,
  listTasksSchema,
  updateTaskSchema,
} from '@veyra/contracts';
import { AuthContext, CurrentAuth, RequirePermissions } from '../common/decorators';
import { ZodPipe } from '../common/zod.pipe';
import { TasksService } from './tasks.service';

@Controller('tasks')
export class TasksController {
  constructor(private readonly tasks: TasksService) {}

  @RequirePermissions('tasks:read')
  @Get()
  list(@Query(new ZodPipe(listTasksSchema)) query: ListTasksInput): Promise<Paginated<TaskDto>> {
    return this.tasks.list(query);
  }

  @RequirePermissions('tasks:write')
  @Post()
  create(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodPipe(createTaskSchema)) body: CreateTaskInput,
  ): Promise<TaskDto> {
    return this.tasks.create(auth, body);
  }

  @RequirePermissions('tasks:write')
  @Patch(':id')
  update(
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodPipe(updateTaskSchema)) body: UpdateTaskInput,
  ): Promise<TaskDto> {
    return this.tasks.update(auth, id, body);
  }

  @RequirePermissions('tasks:write')
  @Delete(':id')
  async remove(@Param('id', new ParseUUIDPipe()) id: string): Promise<{ ok: true }> {
    await this.tasks.remove(id);
    return { ok: true };
  }
}
