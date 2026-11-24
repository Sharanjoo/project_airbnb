# Slice 1: account deletion and token revocation

Owner: Farzaan. When a guest deletes their account, their outstanding login tokens must stop
working everywhere, not only in user-service. A JWT stays valid until it expires (8 hours by
default), so the gateway now checks that the account behind a verified token still exists.

## Before this change

Measured on the real stack: after `POST /guests/delete`, the guest's old token could still
request a booking (booking-worker wrote a REQUESTED reservation for the deleted guest), save
listings and open message threads. Only login and the guest's own profile were refused.

## Design

| Layer | What it does | Survives a restart? |
| --- | --- | --- |
| MySQL `guests.is_deleted` / `hosts.is_deleted` | **Source of truth.** Set by `POST /guests/delete`. A missing row also counts as revoked | Yes |
| Redis `auth:revoked:<user_id>` | Written by user-service right after the delete commits, kept for the longest token lifetime plus 5 minutes. Every gateway instance sees the deletion on the next request | No, and it doesn't need to |
| Gateway cache | "Revoked" is remembered for good (deletion is permanent). "Active" is reused for 5 s (`ACCOUNT_STATUS_TTL_MS`), so MySQL sees at most one lookup per user every 5 s | Rebuilt on start |

On every request with a valid signature (`services/gateway/src/accountStatus.js`):

1. If the account is cached as revoked, it is revoked.
2. If the Redis marker exists, it is revoked immediately, even if "active" is still cached.
3. If an "active" entry is less than 5 s old, the account is active.
4. Otherwise MySQL decides, and the answer is cached.

**What a revoked account gets is exactly what an expired token gets**, so no client or JWT
contract changes:
- Protected routes answer `401 UNAUTHENTICATED` ("This account is no longer active."), and the
  client already clears its session on that.
- Public routes continue anonymously, with `X-Auth-Status: invalid`.

Login, the token claims (`sub`, `role`) and the session shape are unchanged.

## Failure handling

| Situation | Result |
| --- | --- |
| Redis down, slow (over 100 ms) or flushed | Ignored; MySQL decides. A deletion takes effect within 5 s instead of at once |
| Redis down while deleting | The delete still succeeds (MySQL is authoritative). The write is capped at 500 ms. Repeating the delete rewrites the marker |
| MySQL down, account seen active in the last 60 s | Still let in. Its own service needs MySQL anyway |
| MySQL down, account not seen recently | **Fail closed.** Protected routes answer `503 DEPENDENCY_UNAVAILABLE` (retryable, so the client does not log out). Public routes continue anonymously without `X-Auth-Status` |
| MySQL and Redis down, account already known revoked | Still revoked |
| A token for an id user-service never issues (not `gst_` or `hst_`) | Revoked, with no query |

## Concurrency with bookings

`POST /guests/delete` is now one transaction:

1. Lock the guest row `FOR UPDATE`.
2. Count active reservations with a plain read. Its snapshot starts after the lock is granted.
3. Set `is_deleted`.

A reservation insert needs a shared lock on the guest row (foreign key), so:
- **A booking that commits first is counted**, and the delete answers 409. Tested: delete
  waits for an open booking transaction, then refuses.
- **A booking that runs after the delete commits waits for it,** then sees the deletion,
  provided the booking worker checks for it (below).
- **The count deliberately takes no range locks.** A `FOR SHARE` count took gap locks on the
  reservations index and deadlocked with other guests' inserts in testing; the guest-row lock
  already gives the ordering above.

## Limitations that need slice 3 (Sri)

1. **Requests accepted before the delete.** `/bookings/request` answers 202 and publishes
   `booking.requested`; booking-worker writes the reservation later. If the guest deletes their
   account in between, the reservation is written for a deleted guest. Smallest fix, in
   booking-worker's existing transaction, before inserting:
   ```sql
   SELECT is_deleted FROM guests WHERE guest_id = ? FOR SHARE
   ```
   If the guest is deleted, reject the request with reason `GUEST_DELETED`. Tested here with
   that exact step: in 20 races in the test suite, and 60 more in a manual run (45
   booking-first, 15 delete-first), a deleted guest never ended up holding an active stay.
2. **Approve or cancel on behalf of a deleted guest** is not blocked by this change, because hosts
   act on their own token. Whether a host may still confirm a deleted guest's REQUESTED stay
   is a product decision.

## Other limitations

- **Requests already past the gateway** when the delete commits finish normally. This is milliseconds.
- **Open WebSocket connections** to the notification gateway (slice 4) are not closed. They only
  carry the deleted user's own events, and the connection fails on reconnect once the token expires.
- **The messaging worker** may still create a thread for a booking request the guest made just
  before deleting. The host can see it; the deleted guest cannot sign in to read it.
- **Admin rights** removed from `hosts.access_level` still last until the token expires. The same
  check could compare `access_level` for `role: admin` tokens later.

## Tests

- **Gateway** (`services/gateway/test/accounts.test.js`, 16 new):
  - Cache TTL, a permanent revoked entry, the Redis fast path, a lost Redis marker falling back to MySQL.
  - Redis down, MySQL down with and without a recent answer, both down.
  - Unknown id formats.
  - 401 on booking, save, messaging and profile; anonymous with `X-Auth-Status` on public routes.
  - 503 (not 401) when the account cannot be verified; forged tokens refused before any lookup.
- **user-service unit** (5 new): the delete writes the marker, a repeat rewrites it, Redis down still deletes, 409 does not revoke. Marker TTL, lazy connect, hang timeout.
- **user-service MySQL and Redis** (`test/integration/revocation.int.js`, 6 new):
  - The real delete followed by the real gateway check; the marker TTL; a flushed marker still revoked by MySQL.
  - Active and seed users unaffected.
  - The delete waits for an open booking transaction; the 20-race test; concurrent deletes bump the version once.
- **`npm run smoke:auth`:** a new "Deleted account" section checks the old token gets 401 on
  booking, property save, messaging and profile through the real gateway; the public page loads
  with `X-Auth-Status`; re-login fails; other guests are unaffected.
