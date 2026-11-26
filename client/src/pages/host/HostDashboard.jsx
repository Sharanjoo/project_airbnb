// Slice 4: host dashboard (spec §8). Numbers come from
// GET /analytics/host/dashboard and GET /analytics/funnel (MySQL + Mongo, no samples).
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { getSession } from '../../api/client.js';
import { useAnalytics, errorLine } from '../../components/useAnalytics.js';
import {
  StatTile, Tiles, ChartPanel, ColumnChart, LineChart, BarList, RangeFilter, defaultRange, fmt, SERIES,
} from '../../components/charts.jsx';

const STEP_LABELS = { viewed: 'Viewed', saved: 'Saved', requested: 'Requested', confirmed: 'Confirmed', completed: 'Completed' };

export default function HostDashboard() {
  const session = getSession();
  const [range, setRange] = useState(defaultRange(30));
  const skip = !session || session.role !== 'host';
  const dash = useAnalytics('/analytics/host/dashboard', range, { skip });
  const fun = useAnalytics('/analytics/funnel', range, { skip });

  if (!session) return <p>Please <Link to="/login">log in</Link> to see your host dashboard.</p>;
  if (session.role !== 'host') return <p className="muted">The host dashboard is for hosts.</p>;

  const d = dash.data;
  const f = fun.data;
  const funnelItems = f ? Object.keys(STEP_LABELS).map((k, i, keys) => ({
    label: STEP_LABELS[k],
    value: f.steps[k],
    note: i === 0 ? null : stepNote(f.conversion[`${keys[i - 1]}_to_${k}`]),
  })) : [];

  return (
    <div className="dash">
      <div className="dash-head">
        <div>
          <h1>Host dashboard</h1>
          <p className="muted">How your listings are doing.</p>
        </div>
        <RangeFilter value={range} onChange={setRange} />
      </div>

      {(dash.error || fun.error) && <p className="error">{errorLine(dash.error || fun.error)}</p>}
      {dash.loading && !d && <p className="muted">Loading…</p>}

      {d && (
        <>
          <Tiles>
            <StatTile label="Occupancy rate" value={fmt.pct(d.occupancy_rate)} hint="booked ÷ available nights" />
            <StatTile label="Revenue" value={fmt.money(d.revenue_total)} hint="earned on nights in this period" />
            <StatTile label="Average nightly price" value={fmt.money(d.avg_nightly_price)} hint="across active listings" />
            <StatTile label="Cancellations" value={fmt.num(d.cancellations)} />
            <StatTile label="Median response time" value={fmt.min(d.median_response_minutes)} hint="guest's first message to your reply" />
          </Tiles>

          <div className="dash-grid-2">
            <ChartPanel
              wide
              title="Revenue trend"
              subtitle="Revenue earned per night stayed"
              table={{ columns: [{ key: 'date', label: 'Date' }, { key: 'revenue', label: 'Revenue', format: fmt.money }], rows: d.revenue_by_day.filter((r) => r.revenue) }}
            >
              <ColumnChart label="Revenue per day" data={d.revenue_by_day} series={[{ key: 'revenue', name: 'Revenue', color: SERIES.blue }]} format={fmt.money} />
            </ChartPanel>

            <ChartPanel
              title="Views-to-booking funnel"
              subtitle="Each step with its conversion from the step before"
              table={f && {
                columns: [{ key: 'label', label: 'Step' }, { key: 'value', label: 'Count' }, { key: 'note', label: 'From previous step', format: (v) => v || '—' }],
                rows: funnelItems,
              }}
            >
              {f ? <BarList items={funnelItems} max={Math.max(1, ...funnelItems.map((i) => i.value))} /> : <p className="muted">Loading…</p>}
            </ChartPanel>

            <ChartPanel
              title="Rating trend"
              subtitle="Average review rating per month (last 6 months)"
              table={{ columns: [{ key: 'month', label: 'Month' }, { key: 'rating', label: 'Average rating' }], rows: d.rating_trend }}
            >
              <LineChart label="Average rating per month" points={d.rating_trend.map((r) => ({ label: r.month, value: r.rating }))} domain={[0, 5]} format={(v) => (Math.round(v * 100) / 100).toString()} />
            </ChartPanel>
          </div>
        </>
      )}
    </div>
  );
}

function stepNote(rate) {
  return rate === null || rate === undefined ? null : `${fmt.pct(rate)} of previous`;
}
