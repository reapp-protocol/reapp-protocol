# REAPP `/express` + VS Code Testnet Quickstart

This guide creates a completely new local consumer project, points it at the live fulfillment API created by [`reapp.live/express`](https://reapp.live/express), and proves the full REAPP payment boundary on Stellar testnet.

The expected result is:

- three protected JSON resources delivered;
- three unique testnet settlements through `MandateRegistry.execute_payment`;
- the fourth 1 XLM purchase rejected because the 3 XLM mandate budget is exhausted;
- the open `/express` page updating automatically to `3 served / 1 blocked` with explorer links.

The user and agent signing keys remain inside the local Node process. They are never pasted into the browser or sent to REAPP's server.

## What you need

- Node.js 20 or newer;
- npm;
- VS Code;
- internet access to npm, REAPP, Friendbot, and Stellar testnet;
- about two minutes when the public testnet is healthy.

No wallet connection, API key, or funded mainnet account is required. This flow is testnet-only.

## 1. Create the live fulfillment workspace

1. Open [`https://reapp.live/express`](https://reapp.live/express).
2. Leave that browser tab open for the entire run.
3. Click **Create testnet workspace** once.
4. Wait until the page shows **API endpoint ready**.
5. Keep the displayed endpoint and merchant available. The copied consumer example already contains both values.

The page creates a disposable, 30-minute testnet workspace. The generated endpoint has this shape:

```text
https://reapp.live/api/express/<workspace-id>/source
```

Treat the workspace URL as a temporary capability. Do not publish it while the workspace is active.

## 2. Create a clean VS Code project

Open a terminal and run:

```bash
mkdir reapp-express-consumer
cd reapp-express-consumer
git init
npm init -y
npm pkg set type=module
npm pkg set 'scripts.agents:testnet=node consumer.mjs'
npm install @reapp-sdk/core@0.2.3 @stellar/stellar-sdk@14.5.0
code .
```

Create a `.gitignore` file:

```gitignore
node_modules/
.npm-cache/
```

The install creates `package-lock.json`. Keep it. Future clean clones can use `npm ci` for the same dependency graph.

## 3. Add the consumer agent

On `/express`, click **Copy consumer example** and save it as `consumer.mjs` in the new project.

The complete file should match this structure. Replace only the two values marked below if you are entering it manually; the browser's copy button fills them automatically.

```js
import { reapp } from "@reapp-sdk/core";
import { Keypair } from "@stellar/stellar-sdk";

const endpointBase = "PASTE_THE_ENDPOINT_FROM_REAPP_LIVE";
const merchant = "PASTE_THE_MERCHANT_FROM_REAPP_LIVE";
const user = Keypair.random();
const agentKey = Keypair.random();

async function fund(keypair) {
  const response = await fetch(
    "https://friendbot.stellar.org/?addr=" + keypair.publicKey(),
  );
  if (!response.ok) {
    throw new Error(`Friendbot funding failed with HTTP ${response.status}`);
  }
}

await Promise.all([fund(user), fund(agentKey)]);
await new Promise((resolve) => setTimeout(resolve, 3000));

const mandate = reapp.createIntentMandate({
  user: user.publicKey(),
  agent: agentKey.publicKey(),
  merchant,
  asset: reapp.testnet.nativeSac,
  maxAmount: "3.00",
  expiry: Math.floor(Date.now() / 1000) + 3600,
});

const registerTx = await reapp.registerMandate(mandate, { signer: user });
const approveTx = await reapp.approveBudget(mandate, { signer: user });
console.log("mandate ready", { registerTx, approveTx });

const agent = reapp.agent({ mandate, signer: agentKey });
const resources = ["market", "academic", "news", "patents"];
const delivered = [];
let rejected = 0;

for (const [index, resource] of resources.entries()) {
  try {
    const response = await agent.fetch(`${endpointBase}/${resource}`);
    const body = await response.json();

    if (index === 3) throw new Error("the fourth request unexpectedly succeeded");
    if (
      response.status !== 200
      || typeof body.settledTx !== "string"
      || typeof body.data !== "string"
    ) {
      throw new Error(`${resource} returned an invalid protected response`);
    }

    delivered.push(body.settledTx);
    console.log("delivered", {
      resource,
      status: response.status,
      settledTx: body.settledTx,
    });
  } catch (error) {
    if (index !== 3) throw error;

    const report = await fetch(`${endpointBase}/${resource}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        event: "contract_rejected",
        mandateId: mandate.id,
      }),
    });
    if (!report.ok) {
      throw new Error(
        `final on-chain budget verification failed with HTTP ${report.status}`,
      );
    }

    rejected = 1;
    console.log("contract rejected", {
      resource,
      reason: "3 XLM mandate budget exhausted",
    });
  }
}

if (delivered.length !== 3 || rejected !== 1 || new Set(delivered).size !== 3) {
  throw new Error("expected three unique deliveries and one contract rejection");
}

console.log("REAPP TESTNET FLOW PASSED", {
  delivered: 3,
  rejected: 1,
  uniqueSettlements: 3,
});
```

Do not add `user.secret()` or `agentKey.secret()` to logs, source control, environment files, screenshots, or support messages.

## 4. Run the complete flow

In the VS Code terminal, run one command:

```bash
npm run agents:testnet
```

Keep the `/express` page visible while the command runs. It polls the workspace for verified server events and updates automatically.

## 5. Verify the terminal result

A successful run shows this sequence:

```text
mandate ready     registerTx=<hash> approveTx=<hash>
delivered         market    status=200 settledTx=<hash-1>
delivered         academic  status=200 settledTx=<hash-2>
delivered         news      status=200 settledTx=<hash-3>
contract rejected patents   reason=3 XLM mandate budget exhausted
REAPP TESTNET FLOW PASSED    delivered=3 rejected=1 uniqueSettlements=3
```

The fourth `agent.fetch()` is expected to throw a contract simulation error containing `Contract, #6` or `BudgetExceeded`. That is the successful security result: no fourth transfer is submitted.

## 6. Verify the `/express` result

Within a few seconds of the terminal finishing, the still-open browser page must show:

| Evidence | Expected value |
|---|---|
| Served | `3` |
| Blocked | `1` |
| Budget | `3.00 XLM of 3.00 XLM` |
| Remaining | `0.00 XLM` |
| Market | `402 → verified payment → proof → 200` |
| Academic | `402 → verified payment → proof → 200` |
| News | `402 → verified payment → proof → 200` |
| Patents | `402 → contract rejection` |
| Transaction evidence | three distinct settlement links on Stellar Expert |
| Final event | `Run evidence complete · 3 served · 1 blocked` |

The final report is not accepted as a caller assertion. The server reads the supplied public mandate ID from the deployed `MandateRegistry` and records the rejection only when all of these facts match:

- the workspace already served three independently verified payments;
- the on-chain merchant matches the generated fulfillment merchant;
- the on-chain asset is the configured native testnet asset contract;
- `max_amount` is exactly 3 XLM;
- `spent` is exactly 3 XLM;
- the on-chain sequence is exactly three.

## What the endpoints do

| Request | Purpose |
|---|---|
| `POST /api/express` with `{"action":"create"}` | Creates the disposable testnet workspace used by the page. |
| `GET <endpoint>/market` | Returns a 402 requirement, then serves market data after `agent.fetch()` settles and proves payment. |
| `GET <endpoint>/academic` | Same payment flow for the second protected resource. |
| `GET <endpoint>/news` | Same payment flow for the third protected resource. |
| `GET <endpoint>/patents` | Returns the fourth 402; the 3 XLM contract budget prevents settlement. |
| `POST <endpoint>/patents` with the public mandate ID | Makes the server read and verify the exhausted mandate on-chain so the open page can display the rejection. |

## Why this is the safe REAPP pattern

The SDK is untrusted convenience code. The contract remains the enforcement boundary.

1. The fulfillment server returns a payment requirement; it does not trust a client-supplied amount or payee.
2. `agent.fetch()` calls `execute_payment`; it does not replace the contract check with cached application state or a direct token transfer.
3. `MandateRegistry` re-checks the agent, payee, asset, expiry, sequence, and remaining budget atomically.
4. Express independently verifies the settled transaction and exact contract evidence.
5. The redemption store prevents the same payment proof from unlocking a resource twice.
6. Protected JSON is sent only after verification succeeds.

The HTTP shape can evolve independently because mandate creation and contract enforcement live outside the wire adapter. A later payment-header revision should change the consumer/Express adapter, not the `MandateRegistry` authorization model.

## Troubleshooting

### The page says the workspace expired or cannot be found

Workspaces are disposable and can also disappear when the hosted service restarts. Click **Reset**, create a new workspace, copy the new endpoint and merchant into `consumer.mjs`, and run again.

Do not refresh the page during a run. A refresh discards the browser's local workspace view.

### The page returns 429

Workspace creation has a cooldown and a small capacity limit to protect the public testnet. Wait for the displayed retry period, then click **Create testnet workspace** once.

### The endpoint returns 409

Only one action is allowed on a workspace at a time. Do not run two consumer processes against the same endpoint. Wait a moment and restart with a newly created workspace if the previous process was interrupted.

### Friendbot funding fails

Friendbot is a public testnet service. Wait 30–60 seconds, reset the workspace, and rerun from the start with fresh testnet identities. Do not continue a partially completed recording flow.

### npm reports an unwritable global cache

Use a project-local cache without changing system ownership:

```bash
npm_config_cache="$PWD/.npm-cache" npm install @reapp-sdk/core@0.2.3 @stellar/stellar-sdk@14.5.0
```

Keep `.npm-cache/` in `.gitignore`.

### One of the first three calls fails after a possible settlement

Stop the run. Do not blindly retry the same paid request. Check the transaction links already shown on `/express`, reset the workspace, and start a new clean run. This avoids confusing a delivery failure with an unpaid request.

### The fourth call prints `Contract, #6`

That is the expected `BudgetExceeded` rejection. The script reports the public mandate ID to the workspace, the server confirms the exhausted state on-chain, and `/express` changes to `3 served / 1 blocked`.

### The terminal succeeds but the page has not updated

- confirm the browser tab is still open;
- confirm `consumer.mjs` uses the endpoint from that exact tab;
- wait a few seconds for the next status poll;
- do not refresh the page;
- if the hosted service restarted, create a new workspace and rerun.

## Re-running from a clean clone

After committing `package.json`, `package-lock.json`, `consumer.mjs`, and `.gitignore`, the repeatable setup becomes:

```bash
git clone <your-repository-url>
cd reapp-express-consumer
npm ci
npm run agents:testnet
```

Create a fresh `/express` workspace and update the two generated connection values before each recorded run.

## Recording checklist

- [ ] Start on a completely clean local clone.
- [ ] Open `/express` and create one fresh workspace.
- [ ] Show the generated endpoint, merchant, 1 XLM price, and deployed contract link.
- [ ] Run `npm ci` or the first-time install.
- [ ] Run `npm run agents:testnet`.
- [ ] Show the three 200 deliveries in VS Code.
- [ ] Show the fourth contract rejection in VS Code.
- [ ] Return to `/express` and show `3 served / 1 blocked`.
- [ ] Open the three settlement links.
- [ ] Show `0.00 XLM remaining` and the completed event trail.
- [ ] Confirm that no secret key was printed or committed.
