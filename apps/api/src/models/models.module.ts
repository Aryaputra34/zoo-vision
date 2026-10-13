import { Module } from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';
import { BadRequestException } from '@nestjs/common';
import { ENV, type Env } from '../config/env';
import {
  modelExtension,
  ModelUploadStorage,
  ONLY_ONNX_MESSAGE,
} from './model-files';
import { ModelsController } from './models.controller';
import { ModelsService } from './models.service';

@Module({
  imports: [
    MulterModule.registerAsync({
      inject: [ENV],
      useFactory: (env: Env) => ({
        storage: new ModelUploadStorage(
          env.MODELS_DIR,
          env.MODEL_UPLOAD_MAX_BYTES,
        ),
        fileFilter: (_req, file, cb) => {
          if (modelExtension(file.originalname) === 'onnx') cb(null, true);
          else cb(new BadRequestException(ONLY_ONNX_MESSAGE), false);
        },
        limits: {
          // one more than the limit, so the storage engine's own check answers first
          fileSize: env.MODEL_UPLOAD_MAX_BYTES + 1,
          files: 1,
          fields: 10,
          fieldSize: 4096,
          parts: 12,
        },
      }),
    }),
  ],
  controllers: [ModelsController],
  providers: [ModelsService],
  exports: [ModelsService],
})
export class ModelsModule {}
