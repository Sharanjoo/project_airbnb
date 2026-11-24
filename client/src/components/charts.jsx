// Slice 4 chart kit: plain SVG/HTML, no chart library.
// Every chart has a hover tooltip and a "Show table" view, so no value is
// reachable by colour or hover alone. Colours come from dashboards.css
// (--series-1 blue, --series-2 orange; validated for colour-blind separation).
import { useEffect, useId, useRef, useState } from 'react';
import './dashboards.css';

// ---------------------------------------------------------------- formatting
const nf = new Intl.NumberFormat('en-US');
const compactNf = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
export const fmt = {
  num: (v) => (v === null || v === undefined ? '—' : Math.abs(v) >= 10000 ? compactNf.format(v) : nf.format(Math.round(v * 100) / 100)),
  money: (v) => (v === null || v === undefined ? '—' : `$${Math.abs(v) >= 10000 ? compactNf.format(v) : nf.format(Math.round(v * 100) / 100)}`),
  pct: (v) => (v === null || v === undefined ? '—' : `${Math.round(v * 1000) / 10}%`),
  ms: (v) => (v === null || v === undefined ? '—' : v >= 1000 ? `${Math.round(v / 100) / 10} s` : `${Math.round(v)} ms`),
  min: (v) => (v === null || v === undefined ? '—' : `${nf.format(Math.round(v))} min`),
  shortDate: (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }),
};

/** A clean top for the y axis: 1, 2, 2.5 or 5 × 10^n at or above max. */
function niceMax(max) {
  if (!max || max <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(max));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= max) return m * p;
  return 10 * p;
}

// ---------------------------------------------------------------- frame
export function StatTile({ label, value, hint }) {
  return (
    <div className="dash-tile">
      <span className="dash-tile-label">{label}</span>
      <span className="dash-tile-value">{value}</span>
      {hint && <span className="dash-tile-hint">{hint}</span>}
    </div>
  );
}

export function Tiles({ children }) {
  return <div className="dash-tiles">{children}</div>;
}

/** A titled panel with an optional table view (columns: [{key, label, format}]). */
export function ChartPanel({ title, subtitle, table, children, wide }) {
  const [showTable, setShowTable] = useState(false);
  return (
    <section className={`dash-panel${wide ? ' wide' : ''}`}>
      <div className="dash-panel-head">
        <div>
          <h2>{title}</h2>
          {subtitle && <p className="muted">{subtitle}</p>}
        </div>
        {table && (
          <button type="button" className="dash-link" onClick={() => setShowTable(!showTable)} aria-pressed={showTable}>
            {showTable ? 'Show chart' : 'Show table'}
          </button>
        )}
      </div>
      {showTable && table ? <DataTable {...table} /> : children}
    </section>
  );
}

export function DataTable({ columns, rows, empty = 'No data in this period.' }) {
  if (!rows.length) return <p className="muted">{empty}</p>;
  return (
    <div className="dash-table-wrap">
      <table className="dash-table">
        <thead><tr>{columns.map((c) => <th key={c.key}>{c.label}</th>)}</tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>{columns.map((c) => <td key={c.key}>{c.format ? c.format(r[c.key], r) : r[c.key]}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Empty({ children = 'No data in this period yet.' }) {
  return <p className="muted dash-empty">{children}</p>;
}

function Legend({ series }) {
  return (
    <ul className="dash-legend">
      {series.map((s) => (
        <li key={s.key}><span className="dash-swatch" style={{ background: s.color }} />{s.name}</li>
      ))}
    </ul>
  );
}

function Tooltip({ tip }) {
  if (!tip) return null;
  return (
    <div className="dash-tooltip" style={{ left: `${tip.x}%`, top: tip.y }} role="status">
      <strong>{tip.title}</strong>
      {tip.lines.map((l) => <span key={l}>{l}</span>)}
    </div>
  );
}

// ---------------------------------------------------------------- columns over time
const H = 200;
const PAD = { top: 14, right: 8, bottom: 26, left: 44 };

/** Draw at the container's real pixel width, so text stays 11px in narrow panels. */
function useWidth() {
  const ref = useRef(null);
  const [width, setWidth] = useState(640);
  useEffect(() => {
    if (!ref.current) return undefined;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(240, Math.round(e.contentRect.width))));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

/** Axis ticks: 0, middle, top; whole numbers only when the data are counts. */
function ticksFor(lo, hi, integer) {
  const t = [lo, (lo + hi) / 2, hi];
  return integer ? [...new Set(t.filter(Number.isInteger))] : t;
}

/**
 * Columns over time, one or two stacked series.
 * data: [{ date, <series.key>: number }], series: [{ key, name, color }]
 */
export function ColumnChart({ data, series, format = fmt.num, label, integer = false }) {
  const [tip, setTip] = useState(null);
  const titleId = useId();
  const [ref, W] = useWidth();
  if (!data.length) return <Empty />;
  const totals = data.map((d) => series.reduce((s, k) => s + (d[k.key] || 0), 0));
  const top = integer ? Math.max(2, niceMax(Math.max(...totals))) : niceMax(Math.max(...totals));
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const band = plotW / data.length;
  const barW = Math.min(24, Math.max(2, band - 2)); // capped at 24px; leftover is air
  const y = (v) => PAD.top + plotH - (v / top) * plotH;
  const ticks = ticksFor(0, top, integer);
  const labelEvery = Math.max(1, Math.ceil(data.length / Math.max(2, Math.floor(plotW / 70))));
  const peak = totals.indexOf(Math.max(...totals));

  return (
    <div className="dash-chart" ref={ref}>
      {series.length > 1 && <Legend series={series} />}
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" aria-labelledby={titleId} onMouseLeave={() => setTip(null)}>
        <title id={titleId}>{label}</title>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} className="dash-grid" />
            <text x={PAD.left - 6} y={y(t) + 4} className="dash-axis" textAnchor="end">{format(t)}</text>
          </g>
        ))}
        {data.map((d, i) => {
          const x = PAD.left + i * band + (band - barW) / 2;
          let base = 0;
          const segs = series.map((s) => {
            const v = d[s.key] || 0;
            const seg = { s, v, y0: y(base), y1: y(base + v) };
            base += v;
            return seg;
          }).filter((g) => g.v > 0);
          return (
            <g key={d.date}>
              {segs.map((g, k) => {
                const last = k === segs.length - 1;
                const gap = k > 0 ? 2 : 0; // 2px surface gap between stacked segments
                const h = Math.max(0, g.y0 - g.y1 - gap);
                const r = last ? Math.min(4, h, barW / 2) : 0; // rounded data-end, square at the baseline
                const top1 = g.y0 - gap - h;
                const path = `M${x},${g.y0 - gap} V${top1 + r} Q${x},${top1} ${x + r},${top1} H${x + barW - r} Q${x + barW},${top1} ${x + barW},${top1 + r} V${g.y0 - gap} Z`;
                return <path key={g.s.key} d={path} fill={g.s.color} />;
              })}
              {i === peak && totals[i] > 0 && (
                <text x={x + barW / 2} y={y(totals[i]) - 4} className="dash-value" textAnchor="middle">{format(totals[i])}</text>
              )}
              {i % labelEvery === 0 && (
                <text x={x + barW / 2} y={H - 8} className="dash-axis" textAnchor="middle">{fmt.shortDate(d.date)}</text>
              )}
              {/* hit target: the whole band, taller than the mark */}
              <rect
                x={PAD.left + i * band} y={PAD.top} width={band} height={plotH} fill="transparent"
                onMouseEnter={() => setTip({
                  x: ((PAD.left + (i + 0.5) * band) / W) * 100, y: 0,
                  title: fmt.shortDate(d.date),
                  lines: series.map((s) => `${s.name}: ${format(d[s.key] || 0)}`),
                })}
              />
            </g>
          );
        })}
        <line x1={PAD.left} x2={W - PAD.right} y1={y(0)} y2={y(0)} className="dash-baseline" />
      </svg>
      <Tooltip tip={tip} />
    </div>
  );
}

// ---------------------------------------------------------------- line (trend)
/** points: [{ label, value }]; one series, so the title names it and there is no legend. */
export function LineChart({ points, format = fmt.num, domain, label }) {
  const [tip, setTip] = useState(null);
  const titleId = useId();
  const [ref, W] = useWidth();
  if (!points.length) return <Empty />;
  const [lo, hi] = domain || [0, niceMax(Math.max(...points.map((p) => p.value)))];
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const x = (i) => PAD.left + (points.length === 1 ? plotW / 2 : (i / (points.length - 1)) * plotW);
  const y = (v) => PAD.top + plotH - ((v - lo) / (hi - lo)) * plotH;
  const ticks = [lo, (lo + hi) / 2, hi];
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${x(i)},${y(p.value)}`).join(' ');
  const last = points.length - 1;
  return (
    <div className="dash-chart" ref={ref}>
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" aria-labelledby={titleId} onMouseLeave={() => setTip(null)}>
        <title id={titleId}>{label}</title>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} className="dash-grid" />
            <text x={PAD.left - 6} y={y(t) + 4} className="dash-axis" textAnchor="end">{format(t)}</text>
          </g>
        ))}
        <path d={d} className="dash-line" />
        {points.map((p, i) => (
          <g key={p.label}>
            <circle cx={x(i)} cy={y(p.value)} r="4" className="dash-dot" />
            <text x={x(i)} y={H - 8} className="dash-axis" textAnchor="middle">{p.label}</text>
            <circle
              cx={x(i)} cy={y(p.value)} r="14" fill="transparent"
              onMouseEnter={() => setTip({ x: (x(i) / W) * 100, y: 0, title: p.label, lines: [format(p.value)] })}
            />
          </g>
        ))}
        <text x={x(last)} y={y(points[last].value) - 10} className="dash-value" textAnchor="middle">{format(points[last].value)}</text>
      </svg>
      <Tooltip tip={tip} />
    </div>
  );
}

// ---------------------------------------------------------------- horizontal bars
/**
 * Ranked or staged bars with the value printed at the tip.
 * items: [{ label, value, note? }]; `max` fixes the scale (e.g. the funnel's first step).
 */
export function BarList({ items, format = fmt.num, max }) {
  const [tip, setTip] = useState(null);
  if (!items.length) return <Empty />;
  const top = max || Math.max(...items.map((i) => i.value || 0)) || 1;
  return (
    <ul className="dash-bars" onMouseLeave={() => setTip(null)}>
      {items.map((it) => (
        <li
          key={it.label}
          onMouseEnter={() => setTip(it.label)}
          className={tip === it.label ? 'hover' : undefined}
          title={`${it.label}: ${format(it.value)}${it.note ? ` (${it.note})` : ''}`}
        >
          <span className="dash-bar-label">{it.label}</span>
          <span className="dash-bar-track">
            <span className="dash-bar-fill" style={{ width: `${Math.max(it.value ? 1 : 0, ((it.value || 0) / top) * 82)}%` }} />
            <span className="dash-bar-value">{format(it.value)}{it.note && <small> {it.note}</small>}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------- filters
const DAY = 86400000;
/** The viewer's local calendar date (YYYY-MM-DD), so "today" matches their clock. */
const iso = (t) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** Date range presets plus custom from/to, in one row above the charts. */
export function RangeFilter({ value, onChange }) {
  const preset = (days) => onChange({ from: iso(Date.now() - (days - 1) * DAY), to: iso(Date.now()) });
  return (
    <div className="dash-filters">
      {[7, 30, 90].map((d) => (
        <button key={d} type="button" onClick={() => preset(d)}
          className={value.from === iso(Date.now() - (d - 1) * DAY) && value.to === iso(Date.now()) ? 'active' : undefined}>
          {d} days
        </button>
      ))}
      <label>From <input type="date" value={value.from} max={value.to} onChange={(e) => onChange({ ...value, from: e.target.value })} /></label>
      <label>To <input type="date" value={value.to} min={value.from} onChange={(e) => onChange({ ...value, to: e.target.value })} /></label>
    </div>
  );
}

export const defaultRange = (days = 30) => ({ from: iso(Date.now() - (days - 1) * DAY), to: iso(Date.now()) });
export const SERIES = { blue: 'var(--series-1)', orange: 'var(--series-2)' };
