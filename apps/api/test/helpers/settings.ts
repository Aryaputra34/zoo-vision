import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const USECASES = join(__dirname, '../../../../packages/contracts/usecases');

/** The valid example settings of a use case (`examples/settings/valid/<name>.json`). */
export function validSettings(
  useCase: string,
  name = 'current_rules',
): Record<string, unknown> {
  const file = join(
    USECASES,
    useCase,
    'examples',
    'settings',
    'valid',
    `${name}.json`,
  );
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
}
