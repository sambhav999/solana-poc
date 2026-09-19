import { api } from './api.js';
import { signTransactionBase64 } from './wallet.js';

/**
 * Sign and submit a registry transaction the API already prepared.
 * Returns null when the program is not configured yet.
 */
export async function settleRegistryTx({ connection, prepared, submit }) {
  if (!prepared?.available || !prepared.transaction) return null;
  if (prepared.simulation && prepared.simulation.ok === false) return null;
  if (!connection?.wallet || !connection?.account) {
    throw new Error('Connect Phantom before posting the on-chain registry transaction.');
  }
  const signedTransaction = await signTransactionBase64({
    wallet: connection.wallet,
    account: connection.account,
    transactionBase64: prepared.transaction,
  });
  return submit({
    signedTransaction,
    rulePda: prepared.rulePda,
    receiptPda: prepared.receiptPda,
  });
}

export async function settleCreateRuleOnchain({ connection, ruleId, prepared }) {
  return settleRegistryTx({
    connection,
    prepared,
    submit: (payload) => api.submitRuleOnchain(ruleId, payload),
  });
}

export async function settleReceiptOnchain({ connection, ruleId, receiptId, prepared }) {
  return settleRegistryTx({
    connection,
    prepared,
    submit: (payload) => api.submitReceiptOnchain(ruleId, receiptId, payload),
  });
}
