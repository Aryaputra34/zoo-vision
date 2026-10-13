import { Injectable } from '@nestjs/common';
import {
  createValidator,
  loadRegistry,
  type Registry,
  type Validator,
} from '@zoo-vision/contracts';

/** The use case contracts from @zoo-vision/contracts, loaded once per process. */
@Injectable()
export class ContractsService {
  readonly registry: Registry = loadRegistry();
  readonly validator: Validator = createValidator(this.registry);
}
