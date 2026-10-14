import { Module } from '@nestjs/common';
import { UsecasesController } from './usecases.controller';

@Module({ controllers: [UsecasesController] })
export class UsecasesModule {}
