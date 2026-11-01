import TodoPage from '../../components/TodoPage.jsx';

export default function HostDashboard() {
  return (
    <TodoPage
      title="Host dashboard"
      owner="Slice 4"
      endpoints={[
        'GET analytics /analytics/host/dashboard',
        'GET analytics /analytics/funnel',
      ]}
      notes={'Occupancy, revenue, funnel, cancellations, rating trend, response time.'}
    />
  );
}
