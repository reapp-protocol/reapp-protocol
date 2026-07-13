# Reference fulfillment agent

An Express 5 API protected by the safe paid JSON route from
`@reapp-sdk/express-middleware`. One verified settlement executes fulfillment
once; recovery replays the exact stored response bytes.

## Run the live pair

```bash
npm ci
npm run agents:testnet
```

The command creates fresh testnet actors, registers a 3 XLM mandate, starts this
server, serves three paid resources, proves the fourth contract budget rejection,
and rejects an old settlement re-signed for a fresh request.

## Route boundary

```ts
const paidSource = createBoundReappPaidJsonRoute({
  merchant,
  sourceAccount: merchant,
  audience: publicOrigin, // exact origin; never Host-derived
  challengeSecret,
  amount: "1.00",
  resource: (request) => request.originalUrl,
  redemptionStore,
}, async ({ request, payment }) => ({
  body: {
    ok: true,
    source: request.params.id,
    data: CATALOG[request.params.id].data,
    settledTx: payment.txHash,
  },
}));

app.get("/source/:id", validateKnownSource, paidSource);
```

The route requires bound-v2 capability, an authenticated exact-origin GET
challenge, an agent signature, the configured Stellar network, one matching
MandateRegistry event, current mandate identities, one matching SEP-41 transfer,
and an atomic fulfillment claim.

The callback receives no Express response. Its JSON bytes are durably stored
before sending. Repeating the same proof returns byte-identical data without
another chain lookup or callback. A different proof for the same transaction is
`409`; an executing claim or store/RPC outage is `503` and never re-runs work.

## Store choices

- `InMemoryBoundRedemptionStore`: one process and no restart durability; demos/tests.
- `FileBoundRedemptionStore`: fsynced atomic file replacement, owner-only file,
  and one shared in-process queue per normalized path; restart-safe for one process.
- Multi-process/host production: shared durable linearizable database implementing
  `lookup`, `claim`, and `complete`.

Never expire an executing claim back into runnable work. On standalone restart,
the single-process reference resolves prior executing ids to one immutable
terminal result through `resolveBoundReappInterruptedDelivery`. External side
effects still need a transactional operator/job/outbox; automatic re-execution
would violate at-most-once fulfillment.

## Standalone testnet server

```bash
REAPP_MERCHANT=G... \
REAPP_READ_SOURCE=G... \
REAPP_PUBLIC_ORIGIN='https://api.example' \
REAPP_CHALLENGE_SECRET='at-least-32-stable-private-bytes' \
REAPP_REDEMPTION_STORE='./private/redemptions.json' \
npm run start -w @reapp-sdk/fulfillment-agent
```

For localhost, `REAPP_PUBLIC_ORIGIN` may be omitted and the server uses its
actual loopback origin. Public deployment must configure the exact HTTPS origin.
Keep the challenge secret stable and private.

## Unsafe patterns

- Never trust amount, mandate, merchant, or identity from HTTP alone.
- Never accept a successful transaction without the registry event and transfer.
- Never derive the signed audience from an untrusted Host header.
- Never use the low-level authorization middleware with an arbitrary handler.
- Never release result bytes before the atomic completion write.
- Never use file/in-memory stores across a cluster.

Default contract:
[`CC6JMPDH…CRWE`](https://stellar.expert/explorer/testnet/contract/CC6JMPDHRPBR2HBLJKRCIKV54HXDV2RFXDKW6MALQKWM6JEAJQHICRWE),
WASM `13f7023d4a361b6e49d3d39f61f55c5eeece51a602013a3cddae420d2ce8552b`.
