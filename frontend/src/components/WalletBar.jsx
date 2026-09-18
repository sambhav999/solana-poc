import { useEffect, useState } from 'react';
import { listSolanaWallets, onWalletsChanged, connectWallet, disconnectWallet, signMessageBase64, supportsSignMessage } from '../lib/wallet.js';
import { api, setSession, restoreSession, clearSession } from '../lib/api.js';
import { shortAddress } from '../lib/format.js';

/**
 * Connect, then SIGN IN. Connecting only tells the app an address; signing a
 * one-time message proves you control it. Without that second step the server
 * would have to take the address on trust -- which is exactly what let anyone
 * read or delete any wallet's rules before.
 */
export default function WalletBar({ connection, signedIn, onConnect, onSignedIn, onDisconnect }) {
  const [wallets, setWallets] = useState(() => listSolanaWallets());
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [open, setOpen] = useState(false);

  useEffect(() => onWalletsChanged(() => setWallets(listSolanaWallets())), []);

  async function signIn(conn) {
    setBusy('sign'); setError(null);
    try {
      const { nonce, message } = await api.authNonce(conn.address);
      const signature = await signMessageBase64({ wallet: conn.wallet, account: conn.account, message });
      const session = await api.authVerify(conn.address, nonce, signature);
      setSession(session);
      onSignedIn(session);
    } catch (err) {
      setError(/reject|denied|cancel/i.test(err.message) ? 'Sign-in was cancelled in your wallet.' : err.message);
    } finally { setBusy(null); }
  }

  async function handleConnect(wallet) {
    setBusy('connect'); setError(null);
    try {
      const conn = await connectWallet(wallet);
      onConnect(conn);
      setOpen(false);
      // A session from earlier in this tab is reused rather than re-prompting.
      const existing = restoreSession(conn.address);
      if (existing) onSignedIn(existing);
      else if (supportsSignMessage(wallet)) await signIn(conn);
    } catch (err) {
      setError(err.message);
    } finally { setBusy(null); }
  }

  async function handleDisconnect() {
    if (connection?.wallet) await disconnectWallet(connection.wallet);
    clearSession(connection?.address);
    onDisconnect();
  }

  if (connection) {
    return (
      <div className="mast-right">
        {error && <span className="pill bad">{error}</span>}
        {signedIn ? (
          <span className="pill">✓ {connection.wallet.name} · {shortAddress(connection.address)}</span>
        ) : supportsSignMessage(connection.wallet) ? (
          <button className="btn primary small" onClick={() => signIn(connection)} disabled={Boolean(busy)}>
            {busy === 'sign' ? 'Check your wallet…' : 'Sign in'}
          </button>
        ) : (
          <span className="pill bad">{connection.wallet.name} can't sign messages, so it can't sign in</span>
        )}
        <button className="btn small" onClick={handleDisconnect}>Disconnect</button>
      </div>
    );
  }

  if (!wallets.length) {
    return <div className="mast-right"><span className="pill warn">No Solana wallet detected</span></div>;
  }

  return (
    <div className="mast-right">
      {error && <span className="pill bad">{error}</span>}
      {!open ? (
        <button className="btn primary" onClick={() => setOpen(true)} disabled={Boolean(busy)}>Connect wallet</button>
      ) : (
        wallets.map((w) => (
          <button key={w.name} className="btn" disabled={Boolean(busy)} onClick={() => handleConnect(w)}>
            {busy ? <span className="spinner" /> : w.name}
          </button>
        ))
      )}
    </div>
  );
}
