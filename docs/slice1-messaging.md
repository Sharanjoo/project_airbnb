# Slice 1: messaging

Owner: Farzaan. Covers the six messaging endpoints, the conversation that a booking
request opens, `message.sent`, and the Messages page. Each section gives the chosen
design, a rejected alternative and the trade-off, as section 13.13 of the spec requires.

## What is built

| Piece | Where |
| --- | --- |
| Six endpoints | `services/messaging-service/src/routes.js` |
| MongoDB data access (threads, messages) | `src/models/threads.js`, `src/models/messages.js` |
| Read-only MySQL lookups (listing, reservation, display names) | `src/models/directory.js` |
| `message.sent` publishing, shared by the API and the worker | `src/delivery.js` |
| Messaging worker (`messaging-cg`, `booking.requested`) | `src/worker.js` |
| Messages page | `client/src/pages/shared/Messages.jsx`, `Messages.css` |
| End-to-end check | `scripts/smoke-messaging.js` (`npm run smoke:messaging`) |

No schema changes: the collections and indexes in `infra/mongo/init/001_init.js` are
used as they are. The API doc is not in the repo, so request and response shapes
follow the route stubs, the existing `sendSchema` and the repo conventions
(`{ data, trace_id }`, `{ items, page, page_size, total }`). They are listed below
so they can be checked against the doc.

## Endpoints

All need a guest or host token (the gateway already treats `/api/v1/messaging/*` as protected).

| Endpoint | Body | Answer |
| --- | --- | --- |
| `POST /threads/open` | `{ property_id }` (guest asking about a listing) **or** `{ reservation_id }` (guest or host of that booking) | The thread, `201` if created, `200` if it existed |
| `POST /threads/get` | `{ thread_id }` | The thread |
| `POST /threads/byUser` | `{ page?, page_size? ≤ 50, user_id? }` (`user_id` must be the caller) | `{ items, page, page_size, total }`, most recent message first |
| `POST /messages/list` | `{ thread_id, before?, limit? ≤ 100 }` | `{ items (oldest → newest), has_more, next_before }` |
| `POST /messages/send` | `{ thread_id, message_text ≤ 2000, client_message_id? ≤ 64 }` | The message, `201` new, `200` if that `client_message_id` was already sent |
| `POST /messages/markRead` | `{ thread_id, up_to_message_id? }` | `{ thread_id, marked_read, unread_count }` |

A thread as returned: `thread_id, guest_id, host_id, property_id, reservation_ids, created_at, last_message { message_id, sender_id, preview, timestamp } | null`, plus, for the caller, `property_title`, `counterpart { user_id, name }` and `unread_count`. Guests appear as "First L.", hosts by name; no email or phone.

A message: `message_id, thread_id, sender_id, receiver_id, message_text, timestamp, read_at | null, client_message_id | null, reservation_id | null` (`reservation_id` is set on the note from a booking request).

Errors: `400` validation, `401` no token, `403` a host using `property_id` or `user_id` that is not the caller, `404` unknown **or not yours**, `409 IDEMPOTENCY_KEY_REUSED` (same `client_message_id`, different text), `410` paused listing, `503` Kafka down (the message is saved; resend with the same `client_message_id`).

## Who can see a conversation

**Chosen:** a thread is visible only to the two ids in `thread.participants` (guest and host). Every endpoint loads the thread and checks the caller's id from the token before doing anything else. A thread the caller is not in answers `404`, exactly like a missing one, so thread ids cannot be probed. Admins are not let in: the common `requireRole` passes admins everywhere, but the participant check is by id, not role.

**Rejected:** `403` for "exists but not yours". It is a little friendlier to debug but confirms that an id exists. **Rejected:** admin read access for moderation. Private messages stay private until the team agrees on a moderation feature and an audit trail.

## One conversation per guest, host and listing

**Chosen:** the existing unique index on `(guest_id, host_id, property_id)`. A booking request, a later booking of the same listing, and a guest's question from the listing page all land in the same thread; each reservation id is added to `reservation_ids`. Creation is an upsert on that index, so concurrent requests and redeliveries cannot make two threads (tested with 10 concurrent opens on MongoDB).

**Rejected:** one thread per reservation. It would split one relationship across many threads and the index in the repo already says otherwise.

## Booking request → thread and first message

`messaging-worker` (group `messaging-cg`) consumes `booking.requested`. It uses only fields booking-service sets from the token and the listing row, identical on `main` and `slice3/booking-reads`: `reservation_id, guest_id, host_id, property_id, guest_message`.

1. Create or reuse the thread, add the reservation id.
2. If `guest_message` has text, store it as a message from the guest to the host, timestamped with the event time (so a replay keeps it in place).
3. Publish `message.sent`.

**Duplicate protection.** The first message is stored under the dedupe key `booking:<reservation_id>` in the existing unique `client_message_id` index, so a redelivery, a retry or a replay from the start of the topic finds it instead of inserting another. A missing id in the payload is a `PermanentError` (straight to the DLQ). Tested: 5 concurrent deliveries and a replay give one thread, one message and one `message.sent`; rewinding `messaging-cg` to the earliest offset on the real broker reprocessed 11 events, all duplicates, with nothing new written or published.

`booking.requested` is announced before booking-worker checks the dates, so a thread can exist for a request that is later rejected. That is intentional: the guest can still ask about other dates.

## Sending without duplicates

**Chosen:** the client generates `client_message_id` (a UUID) once per message and reuses it on every retry. The server stores it namespaced as `<thread_id>:<sender_id>:<client_message_id>`, so one user's id can never collide with, or reveal, another user's message, and can never collide with `booking:*`. A repeat returns the stored message with `200`. The same id with different text is `409`.

**`message.sent` exactly when needed.** Each message has a `notified` flag (a one-field outbox). After storing, the service takes a short publish lease on the message, publishes, and sets `notified`. Concurrent duplicates that cannot take the lease do not publish. If Kafka is down the lease is released and the API answers `503`; the client's retry with the same `client_message_id` publishes it. Tested: 6 simultaneous retries give one message and one event.

**Rejected:** dedupe on the raw `client_message_id`. The index is global, so a value reused by two users would return one user's message to the other.

## Pagination and read status

**Chosen:** cursor pagination for history (`before` = the oldest message id the client has; ties on timestamp broken by id), because offsets shift while new messages arrive. The conversation list uses page numbers like the rest of the API. Read status is `read_at` per message, set by `markRead` for messages addressed to the caller; the sender sees "Read". Unread counts are computed per thread when listed (at most 50 threads per page).

**Rejected:** a counter on the thread document. It drifts under concurrent send and mark-read.

## `message.sent` and private content

Payload: `{ message_id, thread_id, sender_id, receiver_id, timestamp }`. Key: `thread_id` (one conversation stays in order). Idempotency key: `message:<message_id>`. Actor: the sender (the guest, for a booking note). Trace: the request's trace id, or the booking request's for the first message.

**No message text, no preview, no `property_id`, `guest_id` or `host_id`.** The notification gateway pushes every payload verbatim to channels derived from those fields, and anyone can join any channel (next section). With this payload `channelsFor()` routes `message.sent` to `user:<receiver_id>` only (asserted in `test/messaging.test.js`), and even a snooper who joins that channel gets ids only (checked end to end in `smoke:messaging`). The Messages page reacts to the push by fetching through `/messages/list`, where the participant check applies.

## Notification gateway: the authorization issue (for Timothy, slice 4)

Not changed here; it is Timothy's service. What `services/notification-gateway/src/index.js` does today:

1. **Any client can join any channel.** `ws.on('message')` adds whatever the client sends in `subscribe` (see the `TODO (slice 4)`). A signed-in user can subscribe to `user:<someone else>` and receive their pushes. Confirmed by `smoke:messaging`: a third user who joined the guest's channel received the guest's `message.sent` frame (ids only, thanks to the payload above).
2. **Property channels carry private booking data.** `channelsFor()` sends any event with a `property_id` to `property:<id>`, and `push()` forwards the full payload. `booking.confirmed` / `cancelled` / `rejected` / `completed` include `guest_id`, `host_id`, dates and the reason, so any user viewing a listing page can collect who booked it and when.
3. **Algorithm not pinned.** `jwt.verify(token, JWT_SECRET)` without `algorithms`. The HTTP gateway pins HS256; this one should too.

The fix, in that file:

```js
// 1. Authorize subscriptions
const allowed = (user, channel) => {
  if (channel === `user:${user.sub}`) return true;                                  // only your own user channel
  if (/^property:prp_[A-Za-z0-9]+$/.test(channel)) return true;                     // public listing updates
  if (/^task:/.test(channel)) return user.role === 'admin';                         // or check the task owner
  return false;
};
for (const c of msg.subscribe || []) if (allowed(ws.user, c)) ws.channels.add(c);

// 2. Private events never reach public channels; listing channels get public fields only
const PUBLIC_PROPERTY_FIELDS = ['property_id', 'check_in', 'check_out', 'start_date', 'end_date', 'status', 'new_status'];
function channelsFor(env) {
  const p = env.payload || {};
  if (env.event_type === TOPICS.MESSAGE_SENT) return p.receiver_id ? [`user:${p.receiver_id}`] : []; // never property:*
  // ...existing user:* and task:* rules unchanged...
  // keep booking.* and availability.changed on property:<id>: PropertyDetail (slice 2) shows
  // "your dates are no longer available" from booking.confirmed/cancelled/rejected check_in/check_out
}
function push(env) {
  const full = frame(env, env.payload);
  const pub = frame(env, Object.fromEntries(PUBLIC_PROPERTY_FIELDS.filter((k) => k in (env.payload || {})).map((k) => [k, env.payload[k]])));
  for (const ws of wss.clients) {
    const own = channels.some((c) => c.startsWith('user:') && ws.channels.has(c));      // the people involved
    const watching = channels.some((c) => c.startsWith('property:') && ws.channels.has(c));
    if (own) ws.send(full); else if (watching) ws.send(pub);                            // no guest_id, host_id, reason
  }
}

// 3. Pin the algorithm
ws.user = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
```

Tests to add on his side: joining `user:<other>` is ignored; a property subscriber gets `booking.confirmed` with `check_in`/`check_out` but without `guest_id`, `host_id` or `reason`; `message.sent` reaches only the receiver.

All current pages stay compatible with this fix: My trips and Requests (slice 3) subscribe to their own `user:<id>`, PropertyDetail (slice 2) to `property:<id>` and reads only `check_in`/`check_out`, and Messages relies on the default `user:<id>` channel. Until this lands, the messaging payload above is what keeps message text out of the gateway.

## Messages page

`/messages` (already in the guest and host menus):

- **Conversation list:** counterpart name, listing, last message preview, unread badge.
- **History:** "Load earlier messages" uses the cursor, and the read or sent state shows on your own messages.
- **Composer:** Enter sends and Shift+Enter adds a new line. A failed send shows **Retry**, which reuses the same `client_message_id`.
- **Live updates:** through `useLiveUpdates`. A `message.sent` push refreshes the list and, when it is for the open thread, the history; the thread is then marked read.

Deep links other pages can use (not added to Sharan's or Sri's pages without asking):

- `/messages?thread=<thread_id>`
- `/messages?reservation=<reservation_id>` opens or creates the booking's thread. Useful from My trips and Requests.
- `/messages?property=<property_id>` lets a guest contact the host from a listing.

Styles are in their own file so they cannot conflict with other slices' edits to `styles.css`.

## Limitations

- **Deleted guests keep working tokens.** A soft-deleted guest can still message until their token expires (8 hours), because messaging does not look up user status. This is the same gap as in the other services.
- **No read-receipt push.** There is no topic for read receipts and none was invented, so the sender sees "Read" on the next refresh or push.
- **Unread counts cost one query per thread** on every list (at most 50). If that gets slow, add a `{ thread_id, receiver_id, read_at }` index (a shared Mongo init change, agreed first).
- **Admins can't read conversations,** by design. Moderation needs a team decision.
- **No links from other pages yet.** Listing, My trips and Requests don't link to the deep links above until Sharan and Sri add them.
