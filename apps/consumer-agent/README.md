# Reference consumer agent

The ResearchAgent buys testnet data through `agent.fetch()`. It never transfers
tokens directly and never decides whether a spend is allowed. Every `402`
purchase calls `MandateRegistry.execute_payment`; the contract re-checks and
consumes the mandate before money moves.

## Run both reference agents

From the repository root:

```bash
npm install
npm run agents:testnet
```

That one run creates fresh user, agent, and merchant keys; funds them with
testnet friendbot; registers and approves a 3 XLM mandate; starts the Express
fulfillment agent; and buys four resources sequentially. Three settle and are
served. The fourth exceeds the mandate and is rejected by the contract.

No local secret, browser wallet, or environment file is required. The generated
keys are testnet-only and exist only for the process lifetime.

## Safe usage

[`buyResearch`](src/research-agent.ts) constructs the agent once and sends every
purchase through the SDK's enforced path:

```ts
const agent = reapp.agent({ mandate, signer: agentSecret });
const response = await agent.fetch(`${serverUrl}/source/${id}`);
```

Purchases are sequential because each payment consumes the mandate's current
sequence. Contract rejection is terminal for that purchase and is surfaced as a
blocked result rather than retried blindly.

Avoid these unsafe alternatives:

- Do not call a token transfer directly; it would not consume or validate the mandate.
- Do not trust cached budget or expiry values; only the contract state is authoritative.
- Do not treat any `200` as proof of payment; use a fulfillment service that independently verifies settlement.
- Do not retry an ambiguous payment failure automatically; determine whether a transaction settled first.

The default contract is the upgradeable simple MandateRegistry
[`CC6JMPDH…CRWE`](https://stellar.expert/explorer/testnet/contract/CC6JMPDHRPBR2HBLJKRCIKV54HXDV2RFXDKW6MALQKWM6JEAJQHICRWE),
from the reproducible [`simple-v0.2.0` release](https://github.com/reapp-protocol/reapp-protocol-contracts/releases/tag/simple-v0.2.0_contracts_simple_mandate_registry_mandate-registry_pkg0.2.0_cli25.1.0).
