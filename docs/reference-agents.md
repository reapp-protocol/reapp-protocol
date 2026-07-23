# Reference consumer and fulfillment agents

The consumer uses `agent.fetch()` with `proofPolicy: "bound-v2-only"`, an atomic
purchase claim, a durable pre-broadcast receipt store, an immutable
application-outcome store, restart hydration, and explicit application
acknowledgment. The fulfillment agent uses `createBoundReappPaidJsonRoute` with an
exact public origin, independent Stellar verification, an agent-signed GET proof, and
one atomic claim/result `BoundRedemptionStore`.

## Evidence

```bash
npm ci
npm run agents:testnet
```

The run creates fresh testnet actors and a 3 XLM mandate, serves three paid resources,
proves the fourth contract rejection, retains exact settlement receipts, and rejects a
settled transaction re-signed for a new request with HTTP `409`.
