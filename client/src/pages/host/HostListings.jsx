import TodoPage from '../../components/TodoPage.jsx';

export default function HostListings() {
  return (
    <TodoPage
      title="My listings"
      owner="Slice 2"
      endpoints={[
        'POST property /properties/create',
        'POST property /properties/update',
        'POST property /properties/delete',
        'POST property /properties/availability',
      ]}
    />
  );
}
