/**
 * Transaction assembly for instructions Overflow builds itself.
 *
 * Jupiter hands back a complete, hosted transaction and confirms it through its
 * own /execute endpoint. Kamino gives us raw instructions instead, so deposits
 * and withdrawals are compiled, simulated, signed by the browser wallet, then
 * broadcast and confirmed here.
 *
 * The backend holds no key. It compiles an UNSIGNED transaction with the user as
 * fee payer and hands over the wire bytes; the signature slot is filled by the
 * wallet.
 */
import {
  address,
  createNoopSigner,
  createTransactionMessage,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstructions,
  compileTransaction,
  getBase64EncodedWireTransaction,
  pipe,
} from '@solana/kit';
import { getLatestBlockhash, simulateTransactionBase64 } from './rpc.js';

export { createNoopSigner, address };

/**
 * Compile instructions into an unsigned, base64 wire transaction.
 * Returns the simulation result too: nothing reaches a wallet unsimulated.
 */
export async function buildUnsignedTransaction({ owner, instructions, simulate = true }) {
  const flat = instructions.filter(Boolean);
  if (!flat.length) throw new Error('buildUnsignedTransaction: no instructions');

  const { blockhash, lastValidBlockHeight } = await getLatestBlockhash();

  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(address(owner), m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash, lastValidBlockHeight }, m),
    (m) => appendTransactionMessageInstructions(flat, m),
  );

  const compiled = compileTransaction(message);
  const base64 = getBase64EncodedWireTransaction(compiled);

  let simulation = null;
  if (simulate) {
    simulation = await simulateTransactionBase64(base64).catch((err) => ({ ok: false, err: err.message, logs: [] }));
  }

  return {
    transaction: base64,
    blockhash,
    lastValidBlockHeight: lastValidBlockHeight.toString(),
    instructionCount: flat.length,
    simulation,
  };
}
