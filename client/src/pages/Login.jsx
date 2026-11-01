import TodoPage from '../components/TodoPage.jsx';

export default function Login() {
  return (
    <TodoPage
      title="Log in / Sign up"
      owner="Slice 1"
      endpoints={[
        'POST user /auth/login',
        'POST user /guests/create',
        'POST user /hosts/create',
      ]}
      notes={'Store { token, user_id, role } with setSession().'}
    />
  );
}
