import { Injectable } from '@nestjs/common';
import { AuthGuard as PassportGuard } from '@nestjs/passport';

@Injectable()
export class LocalAuthGuard extends PassportGuard('local') {}
