import { reportHtml } from './report-html';
import { reportRange } from './report-range';

const header = [
  'bucket_local',
  'camera_id',
  'camera_name',
  'use_case',
  'events.gate_in.count',
];

it('a camera named <script>alert(1)</script> appears only as &lt;script&gt;…', () => {
  const html = reportHtml({
    siteName: '<b>Zoo</b>',
    period: 'day',
    rangeLabel: '2026-10-01',
    generatedAt: '2026-10-02 08:00',
    generatedBy: '"><img src=x onerror=alert(2)>',
    header,
    rows: [
      ['2026-10-01 09:00:00', 'c1', '<script>alert(1)</script>', 'gate', 3],
    ],
    labels: { 'events.gate_in.count': '<i>Masuk</i> (jumlah)' },
  });
  expect(html).not.toContain('<script');
  expect(html).not.toContain('<img');
  expect(html).not.toContain('<i>');
  expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  expect(html).toContain('&lt;b&gt;Zoo&lt;/b&gt;');
});

it('no rows → one line saying so', () => {
  const html = reportHtml({
    siteName: 'Zoo',
    period: 'week',
    rangeLabel: 'x',
    generatedAt: 'x',
    generatedBy: 'x',
    header,
    rows: [],
    labels: {},
  });
  expect(html).toContain('Tidak ada data untuk periode ini');
});

it('reportRange: week = 7 local days, month = the calendar month', () => {
  const week = reportRange('week', '2026-10-01', 'Asia/Jakarta');
  expect(week.from.toISOString()).toBe('2026-09-30T17:00:00.000Z');
  expect(week.to.toISOString()).toBe('2026-10-07T17:00:00.000Z');
  const month = reportRange('month', '2026-02-15', 'Asia/Jakarta');
  expect(month.from.toISOString()).toBe('2026-01-31T17:00:00.000Z');
  expect(month.to.toISOString()).toBe('2026-02-28T17:00:00.000Z');
  expect(reportRange('day', '2026-10-01', 'Asia/Jakarta').bucket).toBe('hour');
});
