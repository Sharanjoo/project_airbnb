import TodoPage from '../../components/TodoPage.jsx';

export default function Search() {
  return (
    <TodoPage
      title="Search stays"
      owner="Slice 2"
      endpoints={[
        'POST property /properties/search',
      ]}
      notes={'Filters: location, dates, price, type, capacity, amenities, rating.'}
    />
  );
}
