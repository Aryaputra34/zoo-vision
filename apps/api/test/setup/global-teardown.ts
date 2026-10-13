import type { E2eGlobals } from './global-setup';

export default async function globalTeardown(): Promise<void> {
  const containers = (globalThis as E2eGlobals).__zooE2eContainers ?? [];
  await Promise.all(containers.map((container) => container.stop()));
}
