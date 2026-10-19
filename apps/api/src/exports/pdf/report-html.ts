import type { Registry } from '@zoo-vision/contracts';
import type { Period } from './report-range';

export type ReportInput = {
  siteName: string;
  period: Period;
  rangeLabel: string;
  generatedAt: string;
  generatedBy: string;
  header: string[];
  rows: unknown[][];
  labels: Record<string, string>;
};

/** bucket_local, camera_id, camera_name, use_case: the summary query's leading columns. */
const KEYS = 4;
const PERIOD: Record<Period, string> = {
  day: 'Harian',
  week: 'Mingguan',
  month: 'Bulanan',
};
const ENTITY: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

const text = (v: unknown): string =>
  typeof v === 'string' || typeof v === 'number' ? String(v) : '';

export const escapeHtml = (value: unknown): string =>
  text(value).replace(/[&<>"']/g, (c) => ENTITY[c]);

/**
 * Column key -> label: the contract schema's `title` when a use case has one, else the key, then
 * the unit; a metric uses its own label.
 */
export function columnLabels(
  registry: Registry,
  header: string[],
): Record<string, string> {
  const contracts = [...registry.useCases.values()];
  const title = (pick: 'events' | 'intervals', name: string) => {
    for (const c of contracts) {
      const t = c[pick][name]?.title;
      if (typeof t === 'string') return t;
    }
    return name;
  };
  const out: Record<string, string> = {};
  for (const key of header.slice(KEYS)) {
    const m =
      /^(events|intervals|metrics)\.(.+)\.(count|total_sec|avg|max)$/.exec(key);
    if (!m) continue;
    const [, group, name, unit] = m;
    if (group === 'events') out[key] = `${title('events', name)} (jumlah)`;
    else if (group === 'intervals')
      out[key] = `${title('intervals', name)} (detik)`;
    else {
      const metric = contracts.find((c) => c.metrics[name])?.metrics[name];
      out[key] = `${metric?.label ?? name} ${unit}`;
    }
  }
  return out;
}

type Column = { key: string; index: number };

const isSum = (key: string) => /^(events|intervals)\./.test(key);
const when = (v: unknown) => text(v).slice(0, 16);
const num = (v: unknown) => (typeof v === 'number' ? v : 0);
const round = (n: number) => Math.round(n * 1000) / 1000;

function table(
  columns: Column[],
  rows: unknown[][],
  labels: Record<string, string>,
  totals?: number[],
): string {
  const head = columns
    .map((c) => `<th>${escapeHtml(labels[c.key] ?? c.key)}</th>`)
    .join('');
  const body = rows
    .map(
      (r) =>
        `<tr><td>${escapeHtml(when(r[0]))}</td>${columns
          .map((c) => `<td class="n">${escapeHtml(r[c.index] ?? '–')}</td>`)
          .join('')}</tr>`,
    )
    .join('');
  const foot = totals
    ? `<tr class="sum"><td>Total</td>${totals
        .map((t) => `<td class="n">${escapeHtml(round(t))}</td>`)
        .join('')}</tr>`
    : '';
  return `<table><thead><tr><th>Waktu</th>${head}</tr></thead><tbody>${body}${foot}</tbody></table>`;
}

/** One bar per bucket, scaled to the column's max; nothing when every value is zero. */
function chart(title: string, buckets: string[], values: number[]): string {
  const max = Math.max(0, ...values);
  if (max <= 0) return '';
  const W = 680;
  const H = 110;
  const slot = W / values.length;
  const hourly = new Set(buckets.map((b) => b.slice(0, 10))).size === 1;
  const step = Math.max(1, Math.ceil(values.length / 12));
  const bars = values
    .map((v, i) => {
      if (v <= 0) return '';
      const h = Math.max(1, (v / max) * (H - 24));
      return `<rect x="${(i * slot + slot * 0.15).toFixed(1)}" y="${(H - 14 - h).toFixed(1)}" width="${(slot * 0.7).toFixed(1)}" height="${h.toFixed(1)}" fill="#2f6f4f"/>`;
    })
    .join('');
  const ticks = buckets
    .map((b, i) =>
      i % step === 0
        ? `<text x="${(i * slot + slot / 2).toFixed(1)}" y="${H - 3}" font-size="8" text-anchor="middle" fill="#555">${escapeHtml(hourly ? b.slice(11, 16) : b.slice(5, 10))}</text>`
        : '',
    )
    .join('');
  return `<figure><figcaption>${escapeHtml(title)} <span>maks ${escapeHtml(round(max))}</span></figcaption><svg viewBox="0 0 ${W} ${H}" width="100%" role="img">${bars}${ticks}</svg></figure>`;
}

const STYLE = `
@page { size: A4 }
* { box-sizing: border-box }
body { font: 11px/1.4 Helvetica, Arial, sans-serif; color: #1b1b1b; margin: 0 }
h1 { font-size: 20px; margin: 0 0 4px }
h2 { font-size: 14px; margin: 18px 0 6px; border-bottom: 1px solid #ccc; padding-bottom: 2px }
h2 small { font-weight: normal; color: #666 }
.meta { color: #555; margin-bottom: 8px }
table { border-collapse: collapse; width: 100%; margin: 6px 0 }
tr { page-break-inside: avoid }
th, td { border: 1px solid #ccc; padding: 2px 5px; text-align: left; font-size: 9px }
th { background: #eef3f0 }
td.n { text-align: right }
tr.sum td { font-weight: bold; background: #f6f6f6 }
figure { margin: 6px 0; page-break-inside: avoid }
figcaption { font-weight: bold; margin-bottom: 2px }
figcaption span { font-weight: normal; color: #666 }
.empty { margin: 24px 0; font-size: 13px }
`;

/** One self-contained page: no script, no external URL; every text from data or settings is escaped. */
export function reportHtml(input: ReportInput): string {
  const { header, rows, labels } = input;
  const columns: Column[] = header
    .map((key, index) => ({ key, index }))
    .slice(KEYS);
  const sums = columns.filter((c) => isSum(c.key));
  const head = `<h1>${escapeHtml(input.siteName)}</h1>
<div class="meta">Laporan ${PERIOD[input.period]} · ${escapeHtml(input.rangeLabel)}<br>Dibuat ${escapeHtml(input.generatedAt)} oleh ${escapeHtml(input.generatedBy)}</div>`;

  let body: string;
  if (rows.length === 0) {
    body = '<p class="empty">Tidak ada data untuk periode ini</p>';
  } else {
    // totals over all cameras per bucket (rows arrive sorted by bucket)
    const byBucket = new Map<string, unknown[]>();
    for (const r of rows) {
      const key = String(r[0]);
      const sum =
        byBucket.get(key) ?? header.map((_, i) => (i === 0 ? key : 0));
      for (const c of sums) sum[c.index] = num(sum[c.index]) + num(r[c.index]);
      byBucket.set(key, sum);
    }
    const totalRows = [...byBucket.values()];
    const grand = sums.map((c) =>
      totalRows.reduce((s, r) => s + num(r[c.index]), 0),
    );
    const charts = (list: unknown[][]) =>
      sums
        .map((c) =>
          chart(
            labels[c.key] ?? c.key,
            list.map((r) => when(r[0])),
            list.map((r) => num(r[c.index])),
          ),
        )
        .join('');
    body = `<section><h2>Total semua kamera</h2>${table(sums, totalRows, labels, grand)}${charts(totalRows)}</section>`;

    const cameras = new Map<string, unknown[][]>();
    for (const r of rows) {
      const id = String(r[1]);
      cameras.set(id, [...(cameras.get(id) ?? []), r]);
    }
    for (const [id, list] of cameras) {
      body += `<section><h2>${escapeHtml(list[0][2] ?? id)} <small>${escapeHtml(id)}</small></h2>${table(columns, list, labels)}${charts(list)}</section>`;
    }
  }

  return `<!doctype html><html lang="id"><head><meta charset="utf-8"><title>${escapeHtml(input.siteName)}</title><style>${STYLE}</style></head><body>${head}${body}</body></html>`;
}
