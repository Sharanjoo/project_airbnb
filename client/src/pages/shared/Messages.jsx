import TodoPage from '../../components/TodoPage.jsx';

export default function Messages() {
  return (
    <TodoPage
      title="Messages"
      owner="Slice 1"
      endpoints={[
        'POST messaging /threads/byUser',
        'POST messaging /messages/list',
        'POST messaging /messages/send',
      ]}
    />
  );
}
