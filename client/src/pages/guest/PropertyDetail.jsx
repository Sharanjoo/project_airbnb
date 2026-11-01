import TodoPage from '../../components/TodoPage.jsx';

export default function PropertyDetail() {
  return (
    <TodoPage
      title="Property detail and booking"
      owner="Slice 2 + Slice 3"
      endpoints={[
        'POST property /properties/get',
        'POST property /properties/save',
        'POST booking /bookings/request',
      ]}
      notes={"useLiveUpdates(['property:<id>']) to grey out dates booked by someone else (13.4)."}
    />
  );
}
