import { localDate, localDayStart } from '../../demo/demo-generators';

export type Period = 'day' | 'week' | 'month';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** The UTC instant of local midnight of `YYYY-MM-DD` on `tz`. */
function dayStart(date: string, tz: string): number {
  const [y, m, d] = date.split('-').map(Number);
  let noon = Date.UTC(y, m - 1, d, 12);
  // noon UTC is another local day in zones beyond ±12 h: step to the wanted day
  const got = localDate(noon, tz);
  if (got < date) noon += DAY;
  else if (got > date) noon -= DAY;
  return localDayStart(noon, tz);
}

/** Local midnight after the local day starting at `start` (a day is 23–25 h at a daylight saving change). */
const nextDay = (start: number, tz: string) =>
  localDayStart(start + 30 * HOUR, tz);

/** day = that day by hour; week = 7 days from `date`; month = the calendar month containing `date`, both by day. */
export function reportRange(
  period: Period,
  date: string,
  tz: string,
): { from: Date; to: Date; bucket: 'hour' | 'day' } {
  if (period === 'month') {
    const first = dayStart(`${date.slice(0, 8)}01`, tz);
    // 32 days after the 1st is always inside the next month; its 1st is the end
    const [y, m] = localDate(first + 32 * DAY, tz).split('-');
    const to = dayStart(`${y}-${m}-01`, tz);
    return { from: new Date(first), to: new Date(to), bucket: 'day' };
  }
  const from = dayStart(date, tz);
  let to = from;
  for (let i = 0; i < (period === 'week' ? 7 : 1); i += 1) to = nextDay(to, tz);
  return {
    from: new Date(from),
    to: new Date(to),
    bucket: period === 'day' ? 'hour' : 'day',
  };
}
