const TRANSIENT_PRISMA = new Set([
  'P1001',
  'P1008',
  'P1017',
  'P2024',
  'P2028',
  'P2034',
]);
/**
 * Connection exceptions (08), deadlock and serialization failures, lock and cancel errors,
 * shutdowns (57P0x), and the classes that only a faulty deployment can raise: syntax or access
 * rule violations such as a missing grant, column or table (42), insufficient resources (53),
 * system errors (58) and internal errors (XX). The application's SQL is static and
 * parameterized, so none of these is ever caused by the data in a request or stream entry.
 */
const TRANSIENT_SQLSTATE =
  /^(08...|40P01|40001|55P03|57014|57P0.|42...|53...|58...|XX...)$/;

/**
 * True for errors that say nothing about the data being written: lost connections, pool and
 * transaction timeouts, deadlocks, serialization and lock failures, cancelled statements,
 * shutdowns, and deployment faults (grant or schema drift, resource exhaustion). Prisma puts the
 * SQLSTATE of a failed query in `meta.driverAdapterError.cause.originalCode`.
 */
export function isTransient(err: unknown): boolean {
  const e = err as {
    code?: unknown;
    meta?: {
      driverAdapterError?: {
        cause?: { originalCode?: unknown; code?: unknown };
      };
    };
  } | null;
  const cause = e?.meta?.driverAdapterError?.cause;
  return [e?.code, cause?.originalCode, cause?.code].some(
    (code) =>
      typeof code === 'string' &&
      (TRANSIENT_PRISMA.has(code) || TRANSIENT_SQLSTATE.test(code)),
  );
}
