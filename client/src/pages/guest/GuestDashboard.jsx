import TodoPage from '../../components/TodoPage.jsx';

export default function GuestDashboard() {
  return (
    <TodoPage
      title="Guest dashboard"
      owner="Slice 4"
      endpoints={[
        'GET analytics /analytics/guest/dashboard',
      ]}
      notes={'Bookings over 30 days, status summary, saved activity, match score, approvals.'}
    />
  );
}
