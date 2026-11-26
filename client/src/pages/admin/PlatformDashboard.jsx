// Slice 4: platform and AI dashboards plus the trace view (spec §8).
//   GET /analytics/platform   events by topic, consumer lag, throughput, errors/retries, DLQ, rejected envelopes, latency
//   GET /analytics/ai         publication timeline, disagreement, challenges, votes, dissent, precision/recall@10, approvals
//   GET /traces/{trace_id}    one booking or recommendation journey, step by step (filter by trace_id for the demo)
// Admin only. Deep link: /dashboards/platform?trace_id=<uuid>
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, getSession } from '../../api/client.js';
import { useAnalytics, errorLine } from '../../components/useAnalytics.js';
import {
  StatTile, Tiles, ChartPanel, BarList, DataTable, RangeFilter, defaultRange, fmt,
} from '../../components/charts.jsx';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default function PlatformDashboard() {
  const session = getSession();
  const [range, setRange] = useState(defaultRange(7));
  const skip = !session || session.role !== 'admin';
  const platform = useAnalytics('/analytics/platform', range, { skip });
  const ai = useAnalytics('/analytics/ai', range, { skip });

  if (!session) return <p>Please <Link to="/login">log in</Link> as an admin to see the platform dashboard.</p>;
  if (session.role !== 'admin') return <p className="muted">The platform and AI dashboards are for admins.</p>;

  return (
    <div className="dash">
      <div className="dash-head">
        <div>
          <h1>Platform and AI dashboards</h1>
          <p className="muted">Live from Kafka, MySQL and MongoDB.</p>
        </div>
        <div className="dash-filters">
          <RangeFilter value={range} onChange={setRange} />
          <button type="button" onClick={() => { platform.reload(); ai.reload(); }}>Refresh</button>
        </div>
      </div>

      <TraceView />

      <h2 className="dash-section-title">Platform</h2>
      {platform.error && <p className="error">{errorLine(platform.error)}</p>}
      {platform.loading && !platform.data && <p className="muted">Loading…</p>}
      {platform.data && <PlatformSection p={platform.data} />}

      <h2 className="dash-section-title">AI agents</h2>
      {ai.error && <p className="error">{errorLine(ai.error)}</p>}
      {ai.loading && !ai.data && <p className="muted">Loading…</p>}
      {ai.data && <AiSection a={ai.data} />}
    </div>
  );
}

// ---------------------------------------------------------------- platform
function PlatformSection({ p }) {
  const topics = Object.entries(p.events_by_topic).map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value);
  const lag = p.consumer_lag ? Object.entries(p.consumer_lag).map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value) : [];
  const total = topics.reduce((s, t) => s + t.value, 0);
  return (
    <>
      {p.kafka_error && <p className="notice">Kafka could not be reached ({p.kafka_error}), so consumer lag and DLQ counts are missing.</p>}
      <Tiles>
        <StatTile label="Throughput" value={rate(p.throughput_per_min)} hint={`${fmt.num(total)} events in range`} />
        <StatTile label="Avg booking latency" value={fmt.ms(p.avg_workflow_latency_ms.booking)} hint="first to last step of a trace" />
        <StatTile label="Avg AI recommendation latency" value={fmt.ms(p.avg_workflow_latency_ms.ai_recommendation)} />
        <StatTile label="Errors" value={fmt.num(p.errors)} hint="failed workflow steps" />
        <StatTile label="Retries" value={fmt.num(p.retries)} />
        <StatTile label="Dead-letter messages" value={p.dlq_messages === null ? '—' : fmt.num(p.dlq_messages)} hint="in all .dlq topics" />
        <StatTile label="Rejected envelopes" value={fmt.num(p.rejected_envelopes)} />
      </Tiles>
      <div className="dash-grid-2">
        <ChartPanel
          title="Events by topic"
          subtitle="Kafka events stored by the analytics consumer"
          table={{ columns: [{ key: 'label', label: 'Topic' }, { key: 'value', label: 'Events' }], rows: topics }}
        >
          <BarList items={topics} />
        </ChartPanel>
        <ChartPanel
          title="Consumer lag"
          subtitle="Messages each consumer group has not processed yet"
          table={{ columns: [{ key: 'label', label: 'Consumer group' }, { key: 'value', label: 'Lag' }], rows: lag }}
        >
          {p.consumer_lag ? <BarList items={lag} /> : <p className="muted">Not available while Kafka is unreachable.</p>}
        </ChartPanel>
      </div>
    </>
  );
}

/** Events per minute; quiet periods show "< 0.01/min" rather than a misleading 0. */
function rate(v) {
  if (v === null || v === undefined) return '—';
  if (v > 0 && v < 0.01) return '< 0.01/min';
  return `${fmt.num(v)}/min`;
}

// ---------------------------------------------------------------- ai
function AiSection({ a }) {
  const timeline = Object.entries(a.publication_timeline_ms)
    .filter(([, v]) => v !== null)
    .map(([label, value]) => ({ label: label === 'verdict' ? 'Verdict' : label, value }))
    .sort((x, y) => x.value - y.value);
  const votes = ['keep', 'switch', 'abstain'].map((k) => ({ label: k[0].toUpperCase() + k.slice(1), value: a.votes[k] || 0 }));
  const approvals = ['approved', 'edited', 'rejected'].map((k) => ({ label: k[0].toUpperCase() + k.slice(1), value: a.approvals[k] || 0 }));
  return (
    <>
      <Tiles>
        <StatTile label="Recommendation tasks" value={fmt.num(a.tasks)} hint={a.version ? `config ${a.version}` : null} />
        <StatTile label="Avg disagreement" value={a.avg_disagreement === null ? '—' : a.avg_disagreement.toFixed(2)} hint="max pairwise top-3 distance" />
        <StatTile label="Challenges" value={fmt.num(a.challenges)} />
        <StatTile label="Dissent rate" value={fmt.pct(a.dissent_rate)} hint="results with a dissent note" />
        <StatTile label="Precision@10" value={a.precision_at_10 === null ? '—' : a.precision_at_10.toFixed(2)} hint="from the evaluated config" />
        <StatTile label="Recall@10" value={a.recall_at_10 === null ? '—' : a.recall_at_10.toFixed(2)} />
      </Tiles>
      <div className="dash-grid-2">
        <ChartPanel
          title="Agent publication timeline"
          subtitle="Average time after the request that each agent published, and the verdict"
          table={{ columns: [{ key: 'label', label: 'Agent' }, { key: 'value', label: 'Time', format: fmt.ms }], rows: timeline }}
        >
          <BarList items={timeline} format={fmt.ms} />
        </ChartPanel>
        <ChartPanel
          title="Votes"
          subtitle="Round 2 votes by choice"
          table={{ columns: [{ key: 'label', label: 'Vote' }, { key: 'value', label: 'Count' }], rows: votes }}
        >
          <BarList items={votes} />
        </ChartPanel>
        <ChartPanel
          title="Human approvals"
          subtitle="Guests' decisions on recommendations"
          table={{ columns: [{ key: 'label', label: 'Decision' }, { key: 'value', label: 'Count' }], rows: approvals }}
        >
          <BarList items={approvals} />
        </ChartPanel>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- trace view
function TraceView() {
  const [params, setParams] = useSearchParams();
  const [input, setInput] = useState(params.get('trace_id') || '');
  const [state, setState] = useState({ data: null, error: null, loading: false });
  const [loadedFor, setLoadedFor] = useState(null);

  async function lookup(id) {
    setParams(id ? { trace_id: id } : {});
    if (!UUID.test(id)) {
      setState({ data: null, error: 'A trace id is a UUID like 7c1e4b2a-0d3f-4f8e-9a11-2b6c5d8e9f01.', loading: false });
      return;
    }
    setState({ data: null, error: null, loading: true });
    try {
      setState({ data: await api('analytics', `/traces/${id}`, null, { method: 'GET' }), error: null, loading: false });
    } catch (err) {
      setState({ data: null, error: err.status === 404 ? 'No events recorded for that trace id.' : errorLine(err), loading: false });
    }
  }

  // follow a deep link once
  const fromUrl = params.get('trace_id');
  if (fromUrl && loadedFor !== fromUrl) {
    setLoadedFor(fromUrl);
    lookup(fromUrl);
  }

  const t = state.data;
  const start = t && t.steps.length ? Date.parse(t.steps[0].timestamp) : 0;
  const span = t ? Math.max(1, t.total_latency_ms) : 1;
  return (
    <section className="dash-panel">
      <div className="dash-panel-head">
        <div>
          <h2>Trace a journey</h2>
          <p className="muted">Every step of one booking or recommendation, across services.</p>
        </div>
      </div>
      <form className="dash-trace-form" onSubmit={(e) => { e.preventDefault(); lookup(input.trim()); }}>
        <label>trace_id <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="7c1e4b2a-0d3f-4f8e-9a11-2b6c5d8e9f01" /></label>
        <button className="primary" type="submit" disabled={state.loading}>Show trace</button>
      </form>
      {state.loading && <p className="muted">Loading…</p>}
      {state.error && <p className="error">{state.error}</p>}
      {t && (
        <>
          <p className="muted">{t.steps.length} steps · total {fmt.ms(t.total_latency_ms)}</p>
          <DataTable
            columns={[
              { key: 'offset', label: 'At', format: (v) => `+${fmt.ms(v)}` },
              { key: 'service', label: 'Service' },
              { key: 'event_type', label: 'Event' },
              { key: 'step', label: 'Step', format: (v) => v || '—' },
              { key: 'latency_ms', label: 'Latency', format: (v) => (v === null ? '—' : fmt.ms(v)) },
              { key: 'status', label: 'Status', format: (v, r) => (r.error ? `${v}: ${r.error}` : v) },
              { key: 'offset', label: 'Timeline', format: (v) => <span className="dash-step-bar" style={{ marginLeft: `${(v / span) * 80}%` }} /> },
            ]}
            rows={t.steps.map((s) => ({ ...s, offset: Date.parse(s.timestamp) - start }))}
          />
        </>
      )}
    </section>
  );
}
