import { useEffect, useState } from 'react';
import { listSolanaWallets, onWalletsChanged, connectWallet, disconnectWallet, signMessageBase64, supportsSignMessage } from '../lib/wallet.js';
import { api, setSession, restoreSession, clearSession } from '../lib/api.js';
import { shortAddress } from '../lib/format.js';
import { IconWallet, IconPower } from './icons.jsx';

/**
 * Connect and sign in as one step. A cancelled signature disconnects so the
 * header never shows Sign in and Disconnect at the same time. Phantom is the
 * only wallet this bar offers; there is no picker.
 */
export default function WalletBar({ connection, signedIn, onConnect, onSignedIn, onDisconnect }) {
  const [wallets, setWallets] = useState(() => listSolanaWallets());
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => onWalletsChanged(() => setWallets(listSolanaWallets())), []);

  async function prove(conn) {
    const { nonce, message } = await api.authNonce(conn.address);
    const signature = await signMessageBase64({ wallet: conn.wallet, account: conn.account, message });
    const session = await api.authVerify(conn.address, nonce, signature);
    setSession(session);
    onConnect(conn);
    onSignedIn(session);
  }

  async function handleConnect(wallet) {
    setBusy('connect');
    setError(null);
    try {
      const conn = await connectWallet(wallet);
      const existing = restoreSession(conn.address);
      if (existing) {
        onConnect(conn);
        onSignedIn(existing);
        return;
      }
      if (!supportsSignMessage(wallet)) {
        await disconnectWallet(wallet);
        setError("Phantom can't sign messages, so it can't sign in");
        return;
      }
      setBusy('sign');
      await prove(conn);
    } catch (err) {
      try { await disconnectWallet(wallet); } catch { /* optional feature */ }
      const cancelled = /reject|denied|cancel/i.test(err.message);
      setError(cancelled ? null : err.message);
      onDisconnect();
    } finally {
      setBusy(null);
    }
  }

  async function handleDisconnect() {
    if (connection?.wallet) await disconnectWallet(connection.wallet);
    clearSession(connection?.address);
    onDisconnect();
  }

  if (connection && signedIn) {
    return (
      <div className="mast-right">
        {error && <span className="pill bad">{error}</span>}
        <div className="wallet-chip">
          <span className="avatar"><IconWallet width={13} height={13} color="#fff" /></span>
          <span className="addr">{shortAddress(connection.address)}</span>
          <button className="disconnect-btn" onClick={handleDisconnect} title="Disconnect" aria-label="Disconnect wallet">
            <IconPower width={13} height={13} />
          </button>
        </div>
      </div>
    );
  }

  if (!wallets.length) {
    return (
      <div className="mast-right">
        <span className="install-hint">
          <a href="https://phantom.app/download" target="_blank" rel="noreferrer">Install Phantom</a>
        </span>
      </div>
    );
  }

  return (
    <div className="mast-right">
      {error && <span className="pill bad">{error}</span>}
      <button className="btn primary" onClick={() => handleConnect(wallets[0])} disabled={Boolean(busy)}>
        {busy ? <span className="spinner" /> : <IconWallet width={14} height={14} />}
        {busy === 'connect' ? 'Connecting…' : busy === 'sign' ? 'Check your wallet…' : 'Connect Phantom'}
      </button>
    </div>
  );
}
