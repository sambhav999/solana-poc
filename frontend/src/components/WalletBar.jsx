import { useEffect, useState } from 'react';
import { listSolanaWallets, onWalletsChanged, connectWallet, disconnectWallet } from '../lib/wallet.js';
import { shortAddress } from '../lib/format.js';

export default function WalletBar({ connection, onConnect, onDisconnect }) {
  const [wallets, setWallets] = useState(() => listSolanaWallets());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [open, setOpen] = useState(false);

  useEffect(() => onWalletsChanged(() => setWallets(listSolanaWallets())), []);

  async function handleConnect(wallet) {
    setBusy(true); setError(null);
    try {
      onConnect(await connectWallet(wallet));
      setOpen(false);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleDisconnect() {
    if (connection?.wallet) await disconnectWallet(connection.wallet);
    onDisconnect();
  }

  if (connection) {
    return (
      <div className="mast-right">
        <span className="pill">{connection.wallet.name} · {shortAddress(connection.address)}</span>
        <button className="btn small" onClick={handleDisconnect}>Disconnect</button>
      </div>
    );
  }

  if (!wallets.length) {
    return (
      <div className="mast-right">
        <span className="pill warn">No Solana wallet detected</span>
      </div>
    );
  }

  return (
    <div className="mast-right">
      {error && <span className="pill bad">{error}</span>}
      {!open ? (
        <button className="btn primary" onClick={() => setOpen(true)} disabled={busy}>Connect wallet</button>
      ) : (
        wallets.map((w) => (
          <button key={w.name} className="btn" disabled={busy} onClick={() => handleConnect(w)}>
            {busy ? <span className="spinner" /> : w.name}
          </button>
        ))
      )}
    </div>
  );
}
