import TodoPage from '../../components/TodoPage.jsx';

export default function MyBookings() {
  return (
    <TodoPage
      title="My trips"
      owner="Slice 3"
      endpoints={[
        'POST booking /bookings/byGuest',
        'POST booking /bookings/cancel',
        'POST review /reviews/create',
      ]}
      notes={'Upcoming, past, cancelled, review prompts.'}
    />
  );
}
