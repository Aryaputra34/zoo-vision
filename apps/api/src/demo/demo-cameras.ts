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
};

/** The use cases a demo camera exists for, with the camera's display name. */
const USE_CASES: [useCase: string, name: string][] = [
  ['cashier_presence', 'Demo cashier desk'],
  ['horse_riding', 'Demo pony rides'],
  ['restaurant_counter', 'Demo restaurant counter'],
  ['restaurant_table', 'Demo restaurant tables'],
  ['vehicle_gate', 'Demo vehicle gate'],
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
export const DEMO_CAMERAS: DemoCamera[] = USE_CASES.map(([useCase, name]) => ({
  id: `demo_${useCase}`,
  name,
  useCase,
  settings: exampleSettings(useCase),
}));

export const DEMO_USERS: {
  username: 'demo-superadmin' | 'demo-manager' | 'demo-user';
  name: string;
  role: Role;
}[] = [
  { username: 'demo-superadmin', name: 'Demo Superadmin', role: 'SUPERADMIN' },
  { username: 'demo-manager', name: 'Demo Manager', role: 'MANAGER' },
  { username: 'demo-user', name: 'Demo User', role: 'USER' },
];
