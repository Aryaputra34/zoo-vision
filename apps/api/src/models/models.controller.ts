import {
  Body,
  CallHandler,
  Controller,
  Delete,
  ExecutionContext,
  Get,
  HttpCode,
  Injectable,
  NestInterceptor,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  BadRequestException,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBody,
  ApiConsumes,
  ApiCreatedResponse,
  ApiOkResponse,
} from '@nestjs/swagger';
import { rm } from 'node:fs/promises';
import type { Request } from 'express';
import { catchError, finalize, Observable, throwError } from 'rxjs';
import { setAudit } from '../audit/audit-context';
import type { Actor } from '../auth/actor';
import { CurrentActor, MinRole } from '../auth/decorators';
import {
  type ModelView,
  type RescanResult,
  UploadModelDto,
} from './dto/model.dto';
import type { StoredUpload } from './model-files';
import { ModelsService } from './models.service';

/**
 * Outermost interceptor of the upload. Whatever happens after multer stored the temp file (a form field that
 * fails validation, a handler error), the temp file does not stay. After a successful move the
 * path no longer exists, so this removes nothing.
 */
@Injectable()
class UploadGuard implements NestInterceptor {
  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = ctx.switchToHttp().getRequest<Request>();
    return next.handle().pipe(
      // multer rejects a request that the client cut off with a plain Error: not a server fault
      catchError((err: unknown) =>
        throwError(() =>
          (err as Error).message === 'Request aborted'
            ? new BadRequestException('The upload was interrupted')
            : err,
        ),
      ),
      finalize(() => {
        if (req.file?.path) void rm(req.file.path, { force: true });
      }),
    );
  }
}

@Controller('models')
export class ModelsController {
  constructor(private readonly models: ModelsService) {}

  @MinRole('MANAGER')
  @Get()
  @ApiOkResponse({ description: 'ModelView[], newest first' })
  list(): Promise<ModelView[]> {
    return this.models.list();
  }

  /** Declared before `:id` so that "rescan" is never read as an id. */
  @MinRole('SUPERADMIN')
  @Post('rescan')
  async rescan(@Req() req: Request): Promise<RescanResult> {
    const result = await this.models.rescan();
    setAudit(req, {
      action: 'model.rescan',
      entity: 'model',
      after: {
        added: result.added.map((m) => m.name),
        skipped: result.skipped.length,
      },
    });
    return result;
  }

  @MinRole('MANAGER')
  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string): Promise<ModelView> {
    return this.models.get(id);
  }

  @MinRole('SUPERADMIN')
  @Post()
  @UseInterceptors(UploadGuard, FileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: {
        file: { type: 'string', format: 'binary' },
        name: { type: 'string' },
        version: { type: 'string' },
        notes: { type: 'string' },
      },
    },
  })
  @ApiCreatedResponse({ description: 'The ModelView (ONNX files only)' })
  async upload(
    @CurrentActor() actor: Actor,
    @UploadedFile() file: (Express.Multer.File & StoredUpload) | undefined,
    @Body() dto: UploadModelDto,
    @Req() req: Request,
  ): Promise<ModelView> {
    if (!file) throw new BadRequestException('The "file" part is required');
    const view = await this.models.registerUpload(actor, file, dto);
    setAudit(req, {
      action: 'model.upload',
      entity: 'model',
      entityId: view.id,
      after: {
        name: view.name,
        version: view.version,
        originalName: view.originalName,
        sha256: view.sha256,
        sizeBytes: view.sizeBytes,
      },
    });
    return view;
  }

  @MinRole('SUPERADMIN')
  @Delete(':id')
  @HttpCode(204)
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
  ): Promise<void> {
    const row = await this.models.remove(id);
    setAudit(req, {
      action: 'model.delete',
      entity: 'model',
      entityId: id,
      before: {
        name: row.name,
        filePath: row.filePath,
        sha256: row.sha256,
      },
    });
  }
}
