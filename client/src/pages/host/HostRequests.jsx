import TodoPage from '../../components/TodoPage.jsx';

export default function HostRequests() {
  return (
    <TodoPage
      title="Reservation requests"
      owner="Slice 3"
      endpoints={[
        'POST booking /bookings/byProperty',
        'POST booking /bookings/approve',
        'POST booking /bookings/decline',
      ]}
    />
  );
}
