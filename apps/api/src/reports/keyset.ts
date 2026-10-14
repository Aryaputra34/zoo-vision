/**
 * The rows that come after `(value, id)` in ascending or descending `(column, id)` order, as a
 * Prisma `where`, for keyset paging.
 *
 * The leading `column >= value` bound adds nothing to the answer. Postgres can not turn the OR
 * into an index bound, so without it every page starts its index scan at the beginning of the
 * range and throws away what was already sent: a long export then costs the square of its size.
 */
export function keysetAfter<W>(
  column: 'time' | 'start',
  after: { value: Date; id: string },
  order: 'asc' | 'desc',
): W {
  const strict = order === 'asc' ? 'gt' : 'lt';
  const loose = order === 'asc' ? 'gte' : 'lte';
  return {
    AND: [
      { [column]: { [loose]: after.value } },
      {
        OR: [
          { [column]: { [strict]: after.value } },
          { [column]: after.value, id: { [strict]: after.id } },
        ],
      },
    ],
  } as W;
}
