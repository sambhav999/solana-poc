/**
 * Combined transaction log for the signed-in wallet.
 *
 * Chain signatures come from RPC. Overflow tags (harvest, create_rule,
 * post_receipt) come from SQLite so a clickable explorer list can say what
 * each known tx was for.
 */
export function explorerTxUrl(signature) {
  if (!signature) return null;
  const cluster = String(process.env.NETWORK || '').includes('devnet') ? '?cluster=devnet' : '';
  return `https://solscan.io/tx/${signature}${cluster}`;
}

function roleLabel(role, extra) {
  if (role === 'create_rule') return extra ? `Rule registered (${extra})` : 'Rule registered on chain';
  if (role === 'post_receipt') return 'Registry receipt posted';
  if (role === 'DIVIDEND') return extra ? `Dividend harvest to ${extra}` : 'Dividend harvest';
  if (role === 'INTEREST') return extra ? `Interest harvest to ${extra}` : 'Interest harvest';
  return 'Wallet transaction';
}

export function overflowTags({ receipts = [], rules = [] }) {
  const bySig = new Map();
  for (const rule of rules) {
    if (!rule.onchainSignature) continue;
    bySig.set(rule.onchainSignature, {
      origin: 'OVERFLOW',
      role: 'create_rule',
      label: roleLabel('create_rule', rule.sourceSymbol || rule.sourceId),
      status: 'CONFIRMED',
      createdAt: rule.updatedAt || rule.createdAt || null,
    });
  }
  for (const r of receipts) {
    if (r.signature) {
      bySig.set(r.signature, {
        origin: 'OVERFLOW',
        role: r.kind || 'harvest',
        label: roleLabel(r.kind, r.destinationSymbol || r.inputs?.destinationSymbol),
        status: r.status || null,
        createdAt: r.createdAt || null,
        receiptId: r.id,
      });
    }
    if (r.onchainSignature) {
      bySig.set(r.onchainSignature, {
        origin: 'OVERFLOW',
        role: 'post_receipt',
        label: roleLabel('post_receipt'),
        status: 'CONFIRMED',
        createdAt: r.createdAt || null,
        receiptId: r.id,
      });
    }
  }
  return bySig;
}

export function mergeTransactionLog({ chain = [], receipts = [], rules = [] }) {
  const tags = overflowTags({ receipts, rules });
  const seen = new Set();
  const rows = [];

  for (const item of chain) {
    if (!item?.signature || seen.has(item.signature)) continue;
    seen.add(item.signature);
    const tag = tags.get(item.signature);
    rows.push({
      signature: item.signature,
      explorerUrl: explorerTxUrl(item.signature),
      slot: item.slot,
      err: item.err,
      blockTime: item.blockTime,
      confirmationStatus: item.confirmationStatus,
      origin: tag?.origin || 'WALLET',
      role: tag?.role || 'wallet',
      label: tag?.label || roleLabel('wallet'),
      status: tag?.status || (item.err ? 'FAILED' : (item.confirmationStatus || 'CONFIRMED')),
      createdAt: tag?.createdAt || (item.blockTime ? new Date(item.blockTime * 1000).toISOString() : null),
      receiptId: tag?.receiptId || null,
    });
  }

  for (const [signature, tag] of tags) {
    if (seen.has(signature)) continue;
    seen.add(signature);
    rows.push({
      signature,
      explorerUrl: explorerTxUrl(signature),
      slot: null,
      err: null,
      blockTime: null,
      confirmationStatus: null,
      origin: tag.origin,
      role: tag.role,
      label: tag.label,
      status: tag.status,
      createdAt: tag.createdAt,
      receiptId: tag.receiptId || null,
    });
  }

  rows.sort((a, b) => {
    const ta = a.createdAt ? Date.parse(a.createdAt) : 0;
    const tb = b.createdAt ? Date.parse(b.createdAt) : 0;
    return tb - ta;
  });
  return rows;
}
