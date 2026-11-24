// Slice 4: guest dashboard (spec §8). Every number comes from
// GET /analytics/guest/dashboard: MySQL reservations + Mongo events, no samples.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { getSession } from '../../api/client.js';
import { useAnalytics, errorLine } from '../../components/useAnalytics.js';
import {
  StatTile, Tiles, ChartPanel, ColumnChart, BarList, fmt, SERIES,
} from '../../components/charts.jsx';

const STATUS_LABELS = {
  REQUESTED: 'Requested', CONFIRMED: 'Confirmed', COMPLETED: 'Completed', CANCELLED: 'Cancelled',
  DECLINED: 'Declined', REJECTED: 'Dates unavailable', EXPIRED: 'Expired',
};

export default function GuestDashboard() {
  const session = getSession();
  const [days, setDays] = useState(30);
  const { data, error, loading } = useAnalytics('/analytics/guest/dashboard', { days }, { skip: !session });

  if (!session) return <p>Please <Link to="/login">log in</Link> to see your dashboard.</p>;
  if (session.role !== 'guest') return <p className="muted">The guest dashboard is for guests. Hosts have their own under Host.</p>;

  const total = data ? data.bookings_per_day.reduce((s, d) => s + d.count, 0) : 0;
  const approvals = data ? data.recommendation_approvals : {};
  const saved = data ? data.saved_activity.reduce((s, d) => s + d.saved, 0) : 0;

  return (
    <div className="dash">
      <div className="dash-head">
        <div>
          <h1>Your dashboard</h1>
          <p className="muted">Your bookings, saved places and AI recommendations.</p>
        </div>
        <div className="dash-filters">
          {[7, 30, 90].map((d) => (
            <button key={d} type="button" className={days === d ? 'active' : undefined} onClick={() => setDays(d)}>{d} days</button>
          ))}
        </div>
      </div>

      {error && <p className="error">{errorLine(error)}</p>}
      {loading && !data && <p className="muted">Loading…</p>}

      {data && (
        <>
          <Tiles>
            <StatTile label={`Bookings, last ${days} days`} value={fmt.num(total)} />
            <StatTile label="Places saved" value={fmt.num(saved)} hint={`last ${days} days`} />
            <StatTile label="Average match score" value={data.avg_match_score === null ? '—' : fmt.pct(data.avg_match_score)} hint="AI recommendations you received" />
            <StatTile label="Recommendations approved" value={fmt.num(approvals.approved)} hint={`${fmt.num(approvals.edited)} edited · ${fmt.num(approvals.rejected)} rejected`} />
          </Tiles>

          <div className="dash-grid-2">
            <ChartPanel
              wide
              title="Bookings over time"
              subtitle="Booking requests you made per day"
              table={{ columns: [{ key: 'date', label: 'Date' }, { key: 'count', label: 'Bookings' }], rows: data.bookings_per_day.filter((d) => d.count) }}
            >
              <ColumnChart label="Bookings per day" data={data.bookings_per_day} series={[{ key: 'count', name: 'Bookings', color: SERIES.blue }]} integer />
            </ChartPanel>

            <ChartPanel
              title="Reservation status"
              subtitle={`Requests from the last ${days} days, by where they are now`}
              table={{ columns: [{ key: 'label', label: 'Status' }, { key: 'value', label: 'Reservations' }], rows: statusItems(data.status_summary) }}
            >
              <BarList items={statusItems(data.status_summary)} />
            </ChartPanel>

            <ChartPanel
              title="Saved-property activity"
              subtitle="Places you saved and removed per day"
              table={{
                columns: [{ key: 'date', label: 'Date' }, { key: 'saved', label: 'Saved' }, { key: 'unsaved', label: 'Removed' }],
                rows: data.saved_activity.filter((d) => d.saved || d.unsaved),
              }}
            >
              <ColumnChart
                label="Saved and removed properties per day"
                data={data.saved_activity}
                series={[{ key: 'saved', name: 'Saved', color: SERIES.blue }, { key: 'unsaved', name: 'Removed', color: SERIES.orange }]}
                integer
              />
            </ChartPanel>

            <ChartPanel
              title="Recommendation approvals"
              subtitle="What you decided on AI recommendations"
              table={{ columns: [{ key: 'label', label: 'Decision' }, { key: 'value', label: 'Count' }], rows: approvalItems(approvals) }}
            >
              <BarList items={approvalItems(approvals)} />
            </ChartPanel>
          </div>
        </>
      )}
    </div>
  );
}

function statusItems(summary) {
  return Object.entries(summary)
    .filter(([, n]) => n > 0)
    .map(([status, n]) => ({ label: STATUS_LABELS[status] || status, value: n }))
    .sort((a, b) => b.value - a.value);
}

function approvalItems(a) {
  return [
    { label: 'Approved', value: a.approved || 0 },
    { label: 'Edited', value: a.edited || 0 },
    { label: 'Rejected', value: a.rejected || 0 },
  ];
}
