/** Minimal SEP-41 helpers (approve + balance) for granting the contract its
 *  allowance and reading balances — built directly on @stellar/stellar-sdk so
 *  the SDK has no CLI dependency. */
import {
  Address,
  Contract,
  Keypair,
  TransactionBuilder,
  nativeToScVal,
  scValToNative,
  rpc,
} from "@stellar/stellar-sdk";
import type { NetworkConfig } from "./config.js";

const INCLUSION_FEE = "100000";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function settle(server: rpc.Server, hash: string): Promise<void> {
  let res = await server.getTransaction(hash);
  for (let i = 0; res.status === "NOT_FOUND" && i < 30; i += 1) {
    await sleep(1000);
    res = await server.getTransaction(hash);
  }
  if (res.status !== "SUCCESS") {
    throw new Error(`transaction ${hash} did not succeed: ${res.status}`);
  }
}

/** User grants the contract a SEP-41 allowance: approve(from=owner, spender, amount). */
export async function approve(
  net: NetworkConfig,
  tokenId: string,
  owner: Keypair,
  spender: string,
  amount: bigint,
  expirationLedger?: number,
): Promise<string> {
  const server = new rpc.Server(net.rpcUrl, { allowHttp: net.rpcUrl.startsWith("http://") });
  const source = await server.getAccount(owner.publicKey());
  const exp = expirationLedger ?? (await server.getLatestLedger()).sequence + 17280;
  const op = new Contract(tokenId).call(
    "approve",
    new Address(owner.publicKey()).toScVal(),
    new Address(spender).toScVal(),
    nativeToScVal(amount, { type: "i128" }),
    nativeToScVal(exp, { type: "u32" }),
  );
  const built = new TransactionBuilder(source, {
    fee: INCLUSION_FEE,
    networkPassphrase: net.networkPassphrase,
  })
    .addOperation(op)
    .setTimeout(60)
    .build();
  const prepared = await server.prepareTransaction(built);
  prepared.sign(owner);
  const sent = await server.sendTransaction(prepared);
  if (sent.errorResult) throw new Error(`approve submit failed: ${sent.status}`);
  await settle(server, sent.hash);
  return sent.hash;
}

/** Read a SEP-41 balance (simulation only, no signing). */
export async function balance(net: NetworkConfig, tokenId: string, who: string): Promise<bigint> {
  const server = new rpc.Server(net.rpcUrl, { allowHttp: net.rpcUrl.startsWith("http://") });
  const source = await server.getAccount(who).catch(() => null);
  // Use the owner as source if it exists; otherwise any funded account works for a read.
  const acct = source ?? (await server.getAccount(who));
  const op = new Contract(tokenId).call("balance", new Address(who).toScVal());
  const tx = new TransactionBuilder(acct, {
    fee: INCLUSION_FEE,
    networkPassphrase: net.networkPassphrase,
  })
    .addOperation(op)
    .setTimeout(60)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(`balance sim failed: ${sim.error}`);
  return scValToNative(sim.result!.retval) as bigint;
}
