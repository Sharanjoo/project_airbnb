// Placeholder used by every page until its owner builds it.
export default function TodoPage({ title, owner, endpoints = [], notes }) {
  return (
    <section className="todo">
      <h1>{title}</h1>
      <p>Owner: {owner}</p>
      {endpoints.length > 0 && (
        <>
          <p>Calls:</p>
          <ul>
            {endpoints.map((e) => (
              <li key={e}>
                <code>{e}</code>
              </li>
            ))}
          </ul>
        </>
      )}
      {notes && <p>{notes}</p>}
    </section>
  );
}
