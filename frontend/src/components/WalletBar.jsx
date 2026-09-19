import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  listSolanaWallets,
  onWalletsChanged,
  connectPhantom,
  disconnectWallet,
  signMessageBase64,
  supportsSignMessage,
  explainPhantomConnectError,
  PHANTOM_CONNECT_EVENT,
} from '../lib/wallet.js';
import { api, setSession, restoreSession, clearSession } from '../lib/api.js';
import { tagError, trace, traceError } from '../lib/trace.js';
import { shortAddress } from '../lib/format.js';
import { IconWallet, IconPower } from './icons.jsx';

/**
 * Connect and sign in as one step. A cancelled signature disconnects so the
 * header never shows Sign in and Disconnect at the same time. Phantom is the
 * only wallet this bar offers; there is no picker.
 */
export default function WalletBar({ connection, signedIn, onConnect, onSignedIn, onDisconnect }) {
  const [, setWallets] = useState(() => listSolanaWallets());
  const [busy, setBusy] = useState(null);
  const [modal, setModal] = useState(null);
  const connectRef = useRef(null);

  useEffect(() => onWalletsChanged(() => setWallets(listSolanaWallets())), []);

  useEffect(() => {
    const refresh = () => setWallets(listSolanaWallets());
    const id = setInterval(refresh, 400);
    const stop = setTimeout(() => clearInterval(id), 5000);
    window.addEventListener('focus', refresh);
    return () => {
      clearInterval(id);
      clearTimeout(stop);
      window.removeEventListener('focus', refresh);
    };
  }, []);

  async function prove(conn) {
    trace('signin:prove:start', { address: conn.address });
    let nonceRes;
    try {
      nonceRes = await api.authNonce(conn.address);
      trace('signin:nonce:ok', { nonce: nonceRes?.nonce, messageChars: nonceRes?.message?.length });
    } catch (err) {
      throw tagError(err, { stage: 'api-nonce', source: 'api' });
    }
    let signature;
    try {
      signature = await signMessageBase64({ wallet: conn.wallet, account: conn.account, message: nonceRes.message });
      trace('signin:signature:ok', { signatureChars: signature?.length });
    } catch (err) {
      throw tagError(err, { stage: 'wallet-sign', source: 'phantom' });
    }
    try {
      const session = await api.authVerify(conn.address, nonceRes.nonce, signature);
      trace('signin:verify:ok', { wallet: session?.wallet, expiresAt: session?.expiresAt });
      setSession(session);
      onConnect(conn);
      onSignedIn(session);
    } catch (err) {
      throw tagError(err, { stage: 'api-verify', source: 'api' });
    }
  }

  async function handleConnect() {
    trace('connect:click');
    const pending = connectPhantom();
    setBusy('connect');
    setModal(null);
    let wallet = null;
    try {
      const conn = await pending;
      wallet = conn.wallet;
      trace('connect:wallet-ok', { address: conn.address, walletName: wallet?.name });
      const existing = restoreSession(conn.address);
      if (existing) {
        trace('connect:restored-session', { wallet: existing.wallet, expiresAt: existing.expiresAt });
        onConnect(conn);
        onSignedIn(existing);
        return;
      }
      if (!supportsSignMessage(wallet)) {
        await disconnectWallet(wallet);
        setModal({
          missing: true,
          source: 'phantom',
          stage: 'wallet-connect',
          message: "Phantom can't sign messages, so it can't sign in",
        });
        return;
      }
      setBusy('sign');
      await prove(conn);
    } catch (err) {
      const dump = traceError('connect:fail', err);
      try { if (wallet) await disconnectWallet(wallet); } catch (disconnectErr) {
        traceError('connect:disconnect-after-fail', disconnectErr);
      }
      const message = err?.message || dump.message || String(err);
      const cancelled = /reject|denied|cancel|4001/i.test(message);
      if (cancelled) {
        trace('connect:cancelled');
        onDisconnect();
        return;
      }
      const missing = err?.code === 'PHANTOM_MISSING'
        || message === 'PHANTOM_MISSING'
        || /not available|no provider|not found|not installed/i.test(message);
      const explained = explainPhantomConnectError(err);
      setModal({
        missing,
        source: err?.source || dump.source || 'phantom',
        stage: err?.stage || dump.stage || 'wallet-connect',
        title: explained?.title,
        message: missing
          ? 'Phantom wallet was not found in this browser.'
          : (explained?.message || (message === 'PHANTOM_MISSING' ? 'Phantom wallet was not found in this browser.' : message)),
        hint: explained?.hint,
        dump,
      });
      onDisconnect();
    } finally {
      setBusy(null);
    }
  }

  connectRef.current = handleConnect;

  useEffect(() => {
    function onRequest() {
      connectRef.current?.();
    }
    window.addEventListener(PHANTOM_CONNECT_EVENT, onRequest);
    return () => window.removeEventListener(PHANTOM_CONNECT_EVENT, onRequest);
  }, []);

  async function handleDisconnect() {
    if (connection?.wallet) await disconnectWallet(connection.wallet);
    clearSession(connection?.address);
    onDisconnect();
  }

  const walletModal = modal && createPortal(
    <div className="story-modal" role="dialog" aria-modal="true" aria-labelledby="phantom-modal-title">
      <button type="button" className="story-modal-backdrop" aria-label="Close" onClick={() => setModal(null)} />
      <div className="wallet-modal-card">
        <h2 id="phantom-modal-title">{modal.title || (modal.missing ? 'Phantom is not available' : 'Could not connect')}</h2>
        <p className="wallet-modal-source">
          {modal.source === 'api'
            ? `This failed in the Overflow API${modal.stage ? ` (${modal.stage})` : ''}. Check the Network tab.`
            : `This failed in Phantom, before any API call${modal.stage ? ` (${modal.stage})` : ''}.`}
        </p>
        <p className="wallet-modal-error">{modal.message}</p>
        {modal.hint && <p className="wallet-modal-hint">{modal.hint}</p>}
        {modal.dump && (
          <pre className="wallet-modal-log">{JSON.stringify(modal.dump, null, 2)}</pre>
        )}
        {modal.missing && (
          <p>
            Install the Phantom extension, or open this site inside the Phantom app.
          </p>
        )}
        <div className="wallet-modal-actions">
          {modal.missing && (
            <a className="btn primary" href="https://phantom.app/download" target="_blank" rel="noreferrer">
              Install Phantom
            </a>
          )}
          {!modal.missing && (
            <button type="button" className="btn primary" onClick={() => { setModal(null); connectRef.current?.(); }}>
              Try again
            </button>
          )}
          <a
            className="btn ghost"
            href={`https://phantom.app/ul/browse/${encodeURIComponent(window.location.href)}`}
            target="_blank"
            rel="noreferrer"
          >
            Open in Phantom
          </a>
          <button type="button" className="btn ghost" onClick={() => setModal(null)}>Close</button>
        </div>
      </div>
    </div>,
    document.body,
  );

  if (connection && signedIn) {
    return (
      <div className="mast-right">
        <div className="wallet-chip">
          <span className="avatar"><IconWallet width={13} height={13} color="#fff" /></span>
          <span className="addr">{shortAddress(connection.address)}</span>
          <button className="disconnect-btn" onClick={handleDisconnect} title="Disconnect" aria-label="Disconnect wallet">
            <IconPower width={13} height={13} />
          </button>
        </div>
        {walletModal}
      </div>
    );
  }

  return (
    <div className="mast-right">
      <button className="btn primary" onClick={handleConnect} disabled={Boolean(busy)}>
        {busy ? <span className="spinner" /> : <IconWallet width={14} height={14} />}
        {busy === 'connect' ? 'Connecting…' : busy === 'sign' ? 'Check your wallet…' : 'Connect Phantom'}
      </button>
      {walletModal}
    </div>
  );
}
