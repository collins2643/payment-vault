# Durable payment-request audit

The x402 server records the lifecycle of paid-route HTTP requests in a private SQLite database. A generated `X-Request-ID` links a request to its settlement attempt, facilitator-reported transaction hash, and final server HTTP status. This creates evidence for future attribution; it does not reconstruct missing logs for the six historical transfers.

## Recorded events

Each event includes an integer sequence, schema version, UTC timestamp, server-generated request ID, static method/route, and network. Valid Railway deployment, service, and environment UUIDs are included when provided by the runtime.

| Event | Meaning |
|---|---|
| `request.started` | The paid-route request reached the audit middleware and its start was committed before the payment middleware ran. |
| `settlement.attempted` | An attempt ID, phase, amount, asset, and destination were committed immediately before the x402 settle operation. This is not proof that funds moved. |
| `settlement.succeeded` | The facilitator reported success and a Stellar transaction hash. Includes the attempt ID and public payer address when supplied. Verify the transaction on-chain before treating it as final financial evidence. |
| `settlement.unconfirmed` | x402 reported a settlement error. A timeout can hide a successful remote transaction, so this event does not prove non-payment. |
| `request.completed` | Node emitted `finish`; includes the final HTTP status and elapsed milliseconds. It means the server handed off the response, not that the client received/read it. |
| `request.closed` | The connection closed before `finish`; final delivery and status are not asserted. Settlement events can still arrive later for the same request. |

`ingress` distinguishes a loopback socket from a network socket, without storing its IP. A `network` value can be a reverse proxy and is not proof of an outside customer or a public-hostname request. Deployment IDs establish the process environment, not customer identity.

Every HTTP attempt gets its own ID: the unpaid 402 challenge and a subsequent signed retry are separate requests. Incoming client `X-Request-ID` values are not trusted or reused.

## Privacy and access

- Only explicitly configured server-owned routes are recorded. The shipped route is `GET /weather`, normalized for Express case/trailing-slash aliases.
- No payment signatures, authorization headers, cookies, API keys, signing secrets, bodies, query strings, arbitrary paths, user agents, raw errors, or IP addresses are persisted.
- The database file has mode `0600`; newly created directories use `0700`. SQLite WAL/SHM files are also private and ignored by Git.
- There is no public audit-history HTTP endpoint. Exports require administrator access to the server/database and include public wallet identifiers, so treat exports as private.
- This is append-only through the application interface, not a cryptographically tamper-proof ledger. A filesystem/database administrator can alter records.

## Railway deployment

Use **one server replica** with its own persistent volume. Do not deploy this change before creating that volume and setting the database path.

1. Attach a volume to the payment-server service, mounted at `/data`. This is the API server, not the separate facilitator.
2. Set `AUDIT_DB_PATH=/data/payment-audit.sqlite`.
3. Keep `STELLAR_NETWORK`, `PAY_TO`, `PRICE_UNITS`, and facilitator settings unchanged.
4. Deploy with Node **22.13 or newer**. The implementation uses built-in `node:sqlite`; Node 22 still labels this API experimental.
5. Confirm `/health` returns 200 and a request to `/weather` without payment returns 402 plus a generated `X-Request-ID`.
6. Export that request ID and verify `request.started` and `request.completed` with status 402.
7. Only after separately authorizing a Testnet payment, export its transaction hash and verify the full four-event success lifecycle and the on-chain transfer.
8. Restart/redeploy the same service with the same volume, then repeat the export to verify retention on the actual host.

Railway supplies `RAILWAY_VOLUME_MOUNT_PATH` automatically for an attached volume; do not manually set it to pretend an ephemeral directory is persistent. The startup guard requires an explicit absolute database path inside the actual reported mount, including a real-path symlink check. Volumes are mounted at runtime, not build/pre-deploy time. ([Railway volume documentation](https://docs.railway.com/volumes))

`NODE_ENV=production` outside Railway also requires an explicit absolute `AUDIT_DB_PATH`; the operator is responsible for ensuring that filesystem persists. Local development defaults to `x402/.audit/payment-audit.sqlite` when started from `x402/`.

This change does not provision a volume, change live variables, merge another PR, deploy, or submit any payment.

## Private export

Run inside the server environment with access to the same database:

```bash
cd x402
AUDIT_DB_PATH=/data/payment-audit.sqlite npm run audit:export -- --request-id REQUEST_UUID
AUDIT_DB_PATH=/data/payment-audit.sqlite npm run audit:export -- --tx STELLAR_TX_HASH
```

The CLI opens an existing database read-only. A transaction filter exports the entire lifecycle of every request with that hash, ordered by event sequence. An unknown hash produces no records; it does not create a database or imply that a payment failed.

For a clean JSONL export without npm's script banner:

```bash
umask 077
AUDIT_DB_PATH=/data/payment-audit.sqlite \
  ./node_modules/.bin/tsx --env-file-if-exists=.env audit-export.ts --tx STELLAR_TX_HASH \
  > /private/location/request-lifecycle.jsonl
```

Do not copy a live `.sqlite` file by itself: recent data may reside in its WAL. Use a consistent SQLite backup or a tested volume-backup procedure. Store backups separately, restrict access, test restore/export, and monitor disk usage. No automatic purge is enabled; define a retention policy and archive before deleting records.

## Failure handling and reconciliation

- Failure to persist `request.started` returns 503 before the x402 middleware can settle.
- Failure to persist `settlement.attempted` uses x402's explicit abort directive. Throwing an ordinary lifecycle-hook exception is insufficient because this SDK catches those exceptions.
- A later storage failure marks the audit unhealthy, makes `/health` return 503, and rejects subsequent paid-route requests with 503. It does not automatically retry an already attempted payment.
- A post-settlement write failure emits a small `audit_write_failed` stderr record containing only a request ID and validated transaction hash when available. It is an emergency repair clue, not a replacement durable store.
- There is no atomic transaction spanning SQLite and the Stellar network. A crash after the remote payment but before the success event can leave only an attempted record. Reconcile incomplete/unconfirmed attempts against the chain and facilitator records before retrying or refunding.
- Preserve repeated transaction hashes under different request IDs rather than overwriting them. Reconciliation must deduplicate financial totals by `(network, transaction hash)` while investigating repeats; request count is not payment count.
- Failed final-status writes and disconnects must not be converted into confident HTTP-success claims.
- After investigating a storage failure, restore the database/volume, restart the process, and verify a read-only export before reopening payment traffic.
- An unauthenticated 402 request also consumes audit space. Apply appropriate ingress rate limits and capacity monitoring; health probes are intentionally not logged.

For multiple replicas, move the audit interface to a shared transactional datastore rather than creating isolated SQLite files per replica. This implementation intentionally does not claim distributed audit completeness.

## Integrating the open reviewer-demo PR

This patch is based on `main`, not on PR #7's `grant-demo` branch. Both modify `x402/server.ts`, so resolve that overlap before merging both:

- Keep a single `x402ResourceServer`; wrap that instance with `audit.attach(resourceServer)` and keep any demo hooks on the same instance.
- Install `app.use(audit.middleware)` before `paymentMiddleware`.
- Retain `registerDemo` and its other imports/settings when resolving the server conflict.
- Do not treat the demo's static `evidence.json` entries as newly recorded audit rows.
- The inner paid `GET /weather` receives its own audit request ID. Linking an outer `POST /api/demo-pay` UI action requires additional trusted server-side parent/child correlation; this patch does not claim that link.
- Re-run the integration suite after resolving the conflict.

## Verification

```bash
cd x402
npm ci
npm run typecheck
npm test
```

The tests use real Express and x402 middleware with a fake in-process facilitator. They do not sign or submit Stellar transactions. Coverage includes successful and unpaid requests, concurrent ID isolation, private-field exclusion, read-only export, restart persistence, repeated hashes, mount/symlink validation, and storage-failure behavior before and after settlement. On-host volume persistence and a real paid settlement still require separately authorized deployment/testing.
