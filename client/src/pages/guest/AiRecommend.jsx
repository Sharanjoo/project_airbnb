import TodoPage from '../../components/TodoPage.jsx';

export default function AiRecommend() {
  return (
    <TodoPage
      title="AI match"
      owner="Slice 5"
      endpoints={[
        'POST ai /ai/requests',
        'WS ai /ai/tasks/{task_id}/stream',
        'POST ai /ai/tasks/{task_id}/approve',
      ]}
      notes={"Show each agent's opinion, challenges, votes and verdict live; no spinner-only UI."}
    />
  );
}
