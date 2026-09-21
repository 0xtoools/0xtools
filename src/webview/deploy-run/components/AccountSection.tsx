import { useState } from 'react';
import type {
  AccountSelection,
  AnvilStatus,
  KeystoreInfo,
  NetworkConfig,
} from '../../../shared/deploy-run-protocol';
import type { Bus } from '../bus';

interface Props {
  network: NetworkConfig;
  anvil: AnvilStatus;
  keystores: KeystoreInfo[];
  selection: AccountSelection;
  bus: Bus;
}

function shorten(addr: string): string {
  if (!addr) return 'no address in keystore JSON';
  return addr.length < 14 ? addr : `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function AccountSection({ network, anvil, keystores, selection, bus }: Props): JSX.Element {
  // Tracks the most-recently-copied address so we can flash a transient ✓ on
  // the button that was clicked. Keyed by the address itself so the same chip
  // and the inline keystore row can share feedback state.
  const [copiedAddr, setCopiedAddr] = useState<string | null>(null);

  const isAnvilMode = network.kind === 'anvil';

  function copyAddress(address: string): void {
    void navigator.clipboard.writeText(address);
    setCopiedAddr(address);
    setTimeout(() => {
      setCopiedAddr((cur) => (cur === address ? null : cur));
    }, 1200);
  }

  async function selectAnvilAccount(index: number, address: string): Promise<void> {
    await bus.request({ kind: 'selectAccount', selection: { kind: 'anvil', index, address } });
  }

  async function selectKeystoreAccount(name: string, address: string): Promise<void> {
    await bus.request({ kind: 'selectAccount', selection: { kind: 'keystore', name, address } });
  }

  function refreshKeystores(): void {
    void bus.request({ kind: 'refreshKeystores' });
  }

  // Resolve the currently active account for the prominent chip at the top of
  // this section. For anvil mode, look it up by index; for keystore mode, find
  // the matching entry (which carries balance/status fields).
  const activeAnvilAccount =
    selection.kind === 'anvil' && network.kind === 'anvil'
      ? anvil.accounts[selection.index]
      : null;
  const activeKeystore =
    selection.kind === 'keystore'
      ? keystores.find((k) => k.name === selection.name)
      : null;

  return (
    <section className="section">
      <h3 className="section-title">
        Account
        <span className="rule" />
        {!isAnvilMode && (
          <span className="right">
            <button className="vsc-button small" onClick={refreshKeystores}>↻ keystores</button>
          </span>
        )}
      </h3>

      {/* Active account chip — always visible when an account is picked. Mirrors
          the env-pill style so the active wallet is unmissable, especially right
          after a keystore unlock. */}
      {activeAnvilAccount && (
        <div className="account-chip on">
          <span className="chip-icon">⚡</span>
          <span className="chip-name">#{(selection as { index: number }).index}</span>
          <code className="chip-addr" title={activeAnvilAccount.address}>
            {activeAnvilAccount.address}
          </code>
          <button
            className="icon-btn"
            title={copiedAddr === activeAnvilAccount.address ? 'Copied!' : 'Copy address'}
            onClick={() => copyAddress(activeAnvilAccount.address)}
          >
            {copiedAddr === activeAnvilAccount.address ? '✓' : '⧉'}
          </button>
          <span className="chip-bal">{activeAnvilAccount.balance}</span>
        </div>
      )}
      {activeKeystore && (
        <div className="account-chip on">
          <span className="chip-icon">🔑</span>
          <span className="chip-name" title={activeKeystore.name}>{activeKeystore.name}</span>
          <code className="chip-addr" title={activeKeystore.address}>
            {activeKeystore.address}
          </code>
          <button
            className="icon-btn"
            title={copiedAddr === activeKeystore.address ? 'Copied!' : 'Copy address'}
            onClick={() => copyAddress(activeKeystore.address)}
          >
            {copiedAddr === activeKeystore.address ? '✓' : '⧉'}
          </button>
          {activeKeystore.balance?.formatted && (
            <span className="chip-bal" title={`${activeKeystore.balance.wei} wei on chain ${activeKeystore.balance.chainId}`}>
              {activeKeystore.balance.formatted}
            </span>
          )}
          {activeKeystore.balanceStatus === 'fetching' && (
            <span className="chip-bal fetching">···</span>
          )}
          {activeKeystore.balanceStatus === 'error' && (
            <span className="chip-bal error" title={activeKeystore.balanceError ?? 'failed to fetch balance'}>
              balance unavailable
            </span>
          )}
          {!isAnvilMode && (
            <button
              className="icon-btn"
              title="Refresh balance"
              onClick={() => void bus.request({ kind: 'refreshBalance' })}
            >
              ↻
            </button>
          )}
        </div>
      )}

      {isAnvilMode && (
        <>
          {!anvil.running && <div className="muted small">Start Anvil to populate accounts.</div>}
          {anvil.running && anvil.accounts.length === 0 && (
            <div className="muted small">No accounts parsed from anvil output.</div>
          )}
          {anvil.running && anvil.accounts.length > 0 && (
            <select
              className="vsc-select mono"
              value={selection.kind === 'anvil' ? selection.index : 0}
              onChange={(e) => {
                const idx = Number(e.target.value);
                const acc = anvil.accounts[idx];
                if (acc) void selectAnvilAccount(idx, acc.address);
              }}
              title="Anvil pre-funded accounts"
            >
              {anvil.accounts.map((acc, idx) => (
                <option key={acc.address} value={idx}>
                  {`#${idx} · ${shorten(acc.address)} · ${acc.balance}`}
                </option>
              ))}
            </select>
          )}
        </>
      )}

      {!isAnvilMode && (
        <>
          {keystores.length === 0 && (
            <div className="muted small">
              No keystores in <span className="mono">~/.foundry/keystores/</span>. Create one with{' '}
              <span className="mono">cast wallet import &lt;name&gt; --interactive</span>.
            </div>
          )}
          {keystores.length > 0 && (
            <ul className="accounts-list">
              {keystores
                // The active keystore is already rendered as a prominent chip
                // above — listing it again creates the "doubled row" the user hit.
                .filter((k) => !(selection.kind === 'keystore' && selection.name === k.name))
                .map((ks) => {
                const isSel = selection.kind === 'keystore' && selection.name === ks.name;
                const balanceText = ks.balance?.formatted;
                const isFetching = ks.balanceStatus === 'fetching';
                const isError = ks.balanceStatus === 'error';
                return (
                  <li
                    key={ks.name}
                    className={`account-row ${isSel ? 'selected' : ''}`}
                    onClick={() => {
                      void selectKeystoreAccount(ks.name, ks.address);
                    }}
                  >
                    <span style={{ display: 'flex', gap: 6, alignItems: 'center', minWidth: 0 }}>
                      <span title="Foundry keystore" style={{ flexShrink: 0 }}>
                        🔑
                      </span>
                      <code className="address" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {ks.name}
                      </code>
                      <span className="muted small" style={{ flexShrink: 0 }}>
                        {shorten(ks.address)}
                      </span>
                    </span>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
                      {balanceText && !isFetching && (
                        <span
                          className="balance-chip"
                          title={ks.balance ? `${ks.balance.wei} wei on chain ${ks.balance.chainId}` : undefined}
                        >
                          {balanceText}
                        </span>
                      )}
                      {isFetching && <span className="balance-chip fetching">···</span>}
                      {isError && (
                        <span
                          className="balance-chip error"
                          title={ks.balanceError ?? 'failed to fetch balance'}
                        >
                          !
                        </span>
                      )}
                      <button
                        className="icon-btn row-copy"
                        title={copiedAddr === ks.address ? 'Copied!' : 'Copy address'}
                        onClick={(e) => {
                          e.stopPropagation();
                          copyAddress(ks.address);
                        }}
                      >
                        {copiedAddr === ks.address ? '✓' : '⧉'}
                      </button>
                      {isSel && (
                        <button
                          className="icon-btn"
                          title="Refresh balance"
                          onClick={(e) => {
                            e.stopPropagation();
                            void bus.request({ kind: 'refreshBalance' });
                          }}
                        >
                          ↻
                        </button>
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
          <div className="muted small">
            Panel deploys sign via your local anvil node. To broadcast with a keystore account,
            run <span className="mono">forge script --account &lt;name&gt;</span> in a terminal
            (Foundry prompts for the password; it never passes through this extension).
          </div>
          {selection.kind === 'keystore' && (
            <div className="hint">
              Balance refreshes when you switch accounts or networks · click ↻ to force-refresh
            </div>
          )}
        </>
      )}
    </section>
  );
}
