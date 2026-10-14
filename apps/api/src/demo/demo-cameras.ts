import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Role } from '../generated/prisma/enums';

/** The engine group of the demo cameras: the real engine on `default` never runs them. */
export const DEMO_GROUP = 'demo';

export type DemoCamera = {
  id: string;
  name: string;
  useCase: string;
  settings: object;
  /** MediaMTX path; null leaves the camera without clips (RECORDING_NOT_AVAILABLE). */
  recordingPath: string | null;
};

/** The use cases a demo camera exists for, with the camera's display name. */
const USE_CASES: [useCase: string, name: string, recordingPath: boolean][] = [
  ['cashier_presence', 'Demo cashier desk', false],
  ['horse_riding', 'Demo pony rides', true],
  ['restaurant_counter', 'Demo restaurant counter', false],
  ['restaurant_table', 'Demo restaurant tables', false],
  ['vehicle_gate', 'Demo vehicle gate', true],
];

/** The valid example settings of a use case in the contracts package (`current_rules.json`). */
function exampleSettings(useCase: string): object {
  const contracts = dirname(
    require.resolve('@zoo-vision/contracts/package.json'),
  );
  const file = join(
    contracts,
    'usecases',
    useCase,
    'examples',
    'settings',
    'valid',
    'current_rules.json',
  );
  return JSON.parse(readFileSync(file, 'utf8')) as object;
}

/** Ids are `demo_<use case>`, one per assignable use case. */
export const DEMO_CAMERAS: DemoCamera[] = USE_CASES.map(
  ([useCase, name, recorded]) => ({
    id: `demo_${useCase}`,
    name,
    useCase,
    settings: exampleSettings(useCase),
    recordingPath: recorded ? `demo_${useCase}` : null,
  }),
);

export const DEMO_USERS: {
  username: 'demo-superadmin' | 'demo-manager' | 'demo-user';
  name: string;
  role: Role;
}[] = [
  { username: 'demo-superadmin', name: 'Demo Superadmin', role: 'SUPERADMIN' },
  { username: 'demo-manager', name: 'Demo Manager', role: 'MANAGER' },
  { username: 'demo-user', name: 'Demo User', role: 'USER' },
];
