# REAPP for non-technical readers

An AI agent does research for you and buys the articles it needs. A smart contract makes sure it can only ever spend what you allowed. Here is the whole story, step by step.

Each step ends with an "Under the hood" line naming the smart-contract method behind it. Skip those and the story still makes sense.

## The steps

### Step 1: You add money to a wallet

You set up Freighter, a Stellar wallet, and load it with $100 of free testnet coins. It is your money, and only you control it.

Under the hood: a normal Stellar account, funded by Friendbot (the testnet faucet). No smart contract yet.

### Step 2: You set the spending rule

You set the rule: this agent, $10 at most, one store, an expiry date. You sign it, and the contract saves it as Active with $0 spent.

Under the hood: `register_mandate`, which you sign. It checks that the budget is positive, the expiry is in the future, and the id is not already taken, then sets `spent = 0, seq = 0, status = Active` itself, so nobody can fake a balance.

### Step 3: You let the contract pull up to $10

You sign an allowance that lets the contract pull up to $10 from your wallet. The allowance goes to the contract, never to the agent, and the money stays in your wallet until a payment actually happens.

Under the hood: a SEP-41 `approve` on the token, with the contract as the spender, capped at the budget. This is what lets the contract move funds later.

### Step 4: The agent hits a paywall

The agent tries to buy an article, and the store says: pay $1 first.

Under the hood: an HTTP `402` with an x402 challenge that says how much, to whom, and in which token. In the SDK, `Agent.fetch(url)` sees the 402. No contract call yet.

### Step 5: The agent checks before paying

The agent reads the rule and asks whether $1 to this store would be allowed right now. Nothing moves yet.

Under the hood: `get_mandate` reads the rule (status, spent, seq), and `validate_mandate` does a read-only dry run. Neither needs a signature, and neither changes anything.

### Step 6: The agent pays through the contract

The agent asks to pay. The contract re-checks every rule, then moves $1 from you straight to the store. This is the only way money ever moves.

Under the hood: `execute_payment`, which the agent signs. In one all-or-nothing transaction it checks the order counter, status, expiry, store, and budget, adds to `spent`, raises the counter, and sends the money from you to the store. The store re-verifies the payment on-chain before it serves the article.

### Step 7: It repeats until the $10 is gone

Each article costs another $1. The contract counts up to $10 and never past it. When spending reaches $10, the rule turns Exhausted and the next payment is refused.

Under the hood: each `execute_payment` raises `spent`. Once `spent` reaches the budget, `status` becomes Exhausted and the next call fails with `BudgetExceeded`.

### Step 8: You can cancel any time

You can kill the rule whenever you want, and every payment after that is refused.

Under the hood: `revoke_mandate`, which you sign, sets `status = Revoked`, and later payments fail with `MandateRevoked`. The contract also refuses the wrong store, an expired rule, and repeat payments on its own.

## The methods, in plain English

The contract has five methods, plus the token's `approve`. The "Who signs" column tells you who has to authorize each one.

| Method | Who signs | What it does |
| --- | --- | --- |
| `register_mandate` | You | Saves the rule: who can spend, how much, where, and until when. Starts spending at 0, status Active. |
| `approve` (token) | You | Lets the contract pull up to the budget from your wallet. The allowance goes to the contract, never the agent. |
| `validate_mandate` | No one | A read-only "would this be allowed?" check. Nothing happens on-chain. |
| `execute_payment` | Agent | The only method that moves money. Re-checks every rule, then pays the store from your wallet. |
| `get_mandate` | No one | Looks up the rule and how much has been spent. Read-only. |
| `revoke_mandate` | You | Your kill switch. Cancels the rule so no more payments go through. |

## What the contract refuses

The contract checks these on every payment, and no agent or app can get around them. It says no to:

- Going over your budget
- Paying the wrong store
- Paying after the rule's expiry date
- Paying after you cancelled
- A repeat or out-of-order payment
- A zero or negative amount

## The one thing to remember

The agent never holds your money and never controls the limit. The contract does, and it checks the rules on every single payment. The worst a rogue agent or a hacked app can do is get told no.
