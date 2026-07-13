import { rpc } from "@stellar/stellar-sdk";
import { TESTNET } from "@reapp-sdk/stellar";
import { c, log } from "../ui.js";
import {
  acknowledgeCompletedSettlement,
  classifyMissingSettlement,
  clearPendingSettlement,
  loadPendingSettlement,
  markSettlementCompleted,
} from "../settlement-store.js";

const short = (value: string) => `${value.slice(0, 8)}…${value.slice(-6)}`;
const explorer = (hash: string) => `https://stellar.expert/explorer/testnet/tx/${hash}`;

export async function runSettlementReconcile(): Promise<void> {
  const loaded = await loadPendingSettlement();
  if (loaded.kind === "none") {
    log.info("no prepared payment is pending");
    return;
  }
  if (loaded.kind === "empty") {
    await clearPendingSettlement();
    log.ok("cleared an interrupted pre-broadcast claim; no transaction hash was ever made durable");
    return;
  }

  if (loaded.kind === "completed") {
    const hash = loaded.record.pending.txHash;
    log.chain("prepared payment succeeded and remains durably locked", { tx: short(hash) });
    console.log(c.dim(`  ${explorer(hash)}`));
    log.info(`after you durably accept this result, run \`reapp settlement acknowledge ${hash}\``);
    return;
  }

  const { pending, source, contractId } = loaded.record;
  log.step("reconciling exact prepared transaction", {
    tx: short(pending.txHash),
    source,
    contract: `${contractId.slice(0, 6)}…${contractId.slice(-4)}`,
  });

  const server = new rpc.Server(TESTNET.rpcUrl);
  let response;
  try {
    response = await server.getTransaction(pending.txHash);
  } catch (error) {
    log.err("RPC reconciliation failed; pending state retained", {
      reason: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
    return;
  }

  if (response.status === rpc.Api.GetTransactionStatus.SUCCESS) {
    await markSettlementCompleted(pending.txHash);
    log.chain("prepared payment succeeded; durable acknowledgment is required", { tx: short(pending.txHash) });
    console.log(c.dim(`  ${explorer(pending.txHash)}`));
    log.info(`after you durably accept this result, run \`reapp settlement acknowledge ${pending.txHash}\``);
    return;
  }
  if (response.status === rpc.Api.GetTransactionStatus.FAILED) {
    await clearPendingSettlement(pending.txHash);
    log.warn("prepared payment finalized as failed; journal cleared");
    console.log(c.dim(`  ${explorer(pending.txHash)}`));
    return;
  }

  const decision = classifyMissingSettlement(pending, response);
  if (decision === "expired") {
    await clearPendingSettlement(pending.txHash);
    log.ok("transaction validity window expired with complete retained RPC history; no payment landed");
    return;
  }
  if (decision === "history-pruned") {
    log.err("RPC history no longer covers the full transaction window; journal retained for manual evidence review");
  } else {
    log.warn("transaction is still within its validity/history window; journal retained");
  }
  process.exitCode = 1;
}

export async function runSettlementAcknowledge(txHash: string): Promise<void> {
  try {
    await acknowledgeCompletedSettlement(txHash);
  } catch (error) {
    log.err("completed payment was not acknowledged", {
      reason: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
    return;
  }
  log.ok("completed payment acknowledged; a new payment may now be prepared", {
    tx: short(txHash),
  });
}
