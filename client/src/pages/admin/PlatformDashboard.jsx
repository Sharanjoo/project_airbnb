import TodoPage from '../../components/TodoPage.jsx';

export default function PlatformDashboard() {
  return (
    <TodoPage
      title="Platform and AI dashboards"
      owner="Slice 4"
      endpoints={[
        'GET analytics /analytics/platform',
        'GET analytics /analytics/ai',
        'GET analytics /traces/{trace_id}',
      ]}
      notes={'Filter by trace_id to show one journey end to end.'}
    />
  );
}
