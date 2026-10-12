/* eslint-disable @next/next/no-img-element */
import { FeatureDeck } from "@/components/feature-deck";
import { ModeToggle } from "@/components/mode-toggle";
import { Reveal } from "@/components/reveal";

const VERSION = "0.0.1";
const VSIX_PATH = `/downloads/0xtools-${VERSION}.vsix`;
const VSIX_SIZE = "553 KB";
const GITHUB = "https://github.com/0xtoools/0xtools";

/* ---------- brand mark: the Selector Strip (24 grid · 4 cells · one lit) ---------- */

function Strip({
  className,
  stroke = "currentColor",
  lit = "#14C08A",
}: {
  className?: string;
  stroke?: string;
  lit?: string;
}) {
  const cells = [2.65, 7.75, 12.85, 17.95];
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      {cells.map((x, i) =>
        i === 1 ? (
          <rect key={x} x={x} y={6.5} width={3.4} height={11} rx={1.1} fill={lit} />
        ) : (
          <rect
            key={x}
            x={x}
            y={6.5}
            width={3.4}
            height={11}
            rx={1.1}
            stroke={stroke}
            strokeWidth={1.7}
          />
        ),
      )}
    </svg>
  );
}

/* ---------- top marquee ---------- */

const TICKER = [
  ["transfer(address,uint256)", "0xa9059cbb"],
  ["balanceOf(address)", "0x70a08231"],
  ["approve(address,uint256)", "0x095ea7b3"],
  ["withdraw(uint256)", "0x2e1a7d4d"],
  ["Transfer(address,address,uint256)", "0xddf252ad"],
  ["swapExactTokensForTokens(...)", "0x38ed1739"],
  ["ownerOf(uint256)", "0x6352211e"],
  ["InsufficientBalance()", "0xf4d678b8"],
];

function Ticker() {
  const row = (
    <span className="flex shrink-0 items-center gap-8 pr-8">
      {TICKER.map(([sig, sel]) => (
        <span key={sel} className="flex items-center gap-2 whitespace-nowrap">
          <span className="text-paper/70">{sig}</span>
          <span className="text-accent">→ {sel}</span>
        </span>
      ))}
    </span>
  );
  return (
    <div className="overflow-hidden border-b-2 border-edge bg-dark py-2 font-mono text-xs">
      <div className="flex w-max animate-marquee">
        {row}
        {row}
      </div>
    </div>
  );
}

/* ---------- nav ---------- */

function Nav() {
  return (
    <nav className="border-b-2 border-edge bg-page">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-5 py-4">
        <a href="#" className="flex items-center gap-3">
          <Strip className="h-10 w-10" />
          <img
            src="/brand/0xtools-wordmark.svg"
            alt="0xTools"
            className="h-6 w-auto dark:hidden"
          />
          <img
            src="/brand/0xtools-wordmark-paper.svg"
            alt=""
            className="hidden h-6 w-auto dark:block"
          />
        </a>
        <div className="flex items-center gap-3 font-mono text-sm">
          <ModeToggle />
          <a
            href="#features"
            className="hidden border-b-2 border-transparent px-1 hover:border-accent sm:block"
          >
            FEATURES
          </a>
          <a
            href="#install"
            className="hidden border-b-2 border-transparent px-1 hover:border-accent sm:block"
          >
            INSTALL
          </a>
          <a
            href={GITHUB}
            target="_blank"
            rel="noreferrer"
            className="hidden border-b-2 border-transparent px-1 hover:border-accent sm:block"
          >
            GITHUB ↗
          </a>
          <a
            href={VSIX_PATH}
            download
            className="border-2 border-edge bg-accent px-4 py-2 font-semibold text-ink shadow-brut-sm transition-all hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-none"
          >
            GET .VSIX
          </a>
        </div>
      </div>
    </nav>
  );
}

/* ---------- hero ---------- */

function Hero() {
  return (
    <header className="hero-grid border-b-2 border-edge">
      <div className="mx-auto grid max-w-6xl items-center gap-14 px-5 py-16 lg:grid-cols-2 lg:py-24 [&>*]:min-w-0">
        <div>
          <Reveal delay={0}>
            <div className="mb-5 font-mono text-xs tracking-[0.18em] text-muted">
              SOLIDITY · EVM · SELECTOR DECODING · INLINE GAS
            </div>
          </Reveal>
          <Reveal delay={0.06}>
            <h1 className="text-5xl font-bold leading-[1.04] tracking-tight sm:text-6xl lg:text-7xl">
              Read the{" "}
              <span className="bg-accent px-2 text-ink shadow-brut-sm">EVM</span>{" "}
              without leaving{" "}
              <span className="underline decoration-accent decoration-[6px] underline-offset-8">
                your editor.
              </span>
            </h1>
          </Reveal>
          <Reveal delay={0.14}>
            <p className="mt-6 max-w-xl text-lg leading-relaxed text-body/70">
              0xTools decodes function selectors, event topics and error
              selectors — and annotates gas inline — right inside VS Code. Plus
              security audits, one-click Anvil, and a full EVM toolbox.
            </p>
          </Reveal>
          <Reveal delay={0.22}>
            <div className="mt-9 flex flex-wrap items-center gap-4">
              <a
                href={VSIX_PATH}
                download
                className="border-2 border-edge bg-accent px-6 py-4 font-mono text-sm font-semibold text-ink shadow-brut transition-all hover:translate-x-[3px] hover:translate-y-[3px] hover:shadow-none"
              >
                ↓ DOWNLOAD .VSIX · v{VERSION} · {VSIX_SIZE}
              </a>
              <a
                href={GITHUB}
                target="_blank"
                rel="noreferrer"
                className="border-2 border-edge bg-surface px-6 py-4 font-mono text-sm font-semibold shadow-brut transition-all hover:translate-x-[3px] hover:translate-y-[3px] hover:shadow-none"
              >
                STAR ON GITHUB ↗
              </a>
            </div>
            <div className="mt-6 flex flex-wrap items-center gap-2 font-mono text-[11px]">
              {["MIT LICENSED", "FOUNDRY + HARDHAT", "WORKS OFFLINE", "101 COMMANDS"].map(
                (t) => (
                  <span key={t} className="border border-edge/40 px-2 py-1 text-muted">
                    {t}
                  </span>
                ),
              )}
            </div>
          </Reveal>
        </div>
        <Reveal x={28} y={0} delay={0.15}>
          <div className="relative">
            <div className="absolute -top-4 left-4 z-[60] -rotate-3 border-2 border-ink bg-amber px-3 py-1 font-mono text-[11px] font-semibold text-ink shadow-brut-sm">
              NOT ON THE MARKETPLACE YET — VSIX SHIPS FROM HERE
            </div>
            <FeatureDeck />
          </div>
        </Reveal>
      </div>
    </header>
  );
}

/* ---------- stats ---------- */

const STATS = [
  ["101", "COMMANDS"],
  ["25+", "SECURITY MODULES"],
  ["3-TIER", "GAS ENGINE"],
  ["553 KB", "WHOLE VSIX"],
];

function Stats() {
  return (
    <div className="border-b-2 border-edge bg-dark dark:bg-panel">
      <div className="mx-auto grid max-w-6xl grid-cols-2 sm:grid-cols-4">
        {STATS.map(([big, small], i) => (
          <Reveal key={small} delay={i * 0.07} y={16} className="px-5 py-6 text-center">
            <div className="text-2xl font-bold text-accent sm:text-3xl">{big}</div>
            <div className="mt-1 font-mono text-[11px] tracking-widest text-muted">
              {small}
            </div>
          </Reveal>
        ))}
      </div>
    </div>
  );
}

/* ---------- features ---------- */

const FEATURES: [string, string, string, string][] = [
  [
    "01",
    "GAS ENGINE",
    "Real gas, not guesses",
    "Inline annotations from a three-tier backend (Rust runner → Forge → solc-js), plus optimizer suggestions, snapshots, branch comparison, deployment cost and a runtime profiler.",
  ],
  [
    "02",
    "DECODING",
    "Every selector, named",
    "Function selectors, event topics, error selectors and raw calldata decoded on hover — local 4-byte cache, collision detection, and a searchable signature database.",
  ],
  [
    "03",
    "SECURITY SUITE",
    "25+ analysis modules",
    "Reentrancy, unchecked calls, access control, MEV risks, DeFi patterns, ERC-20/721/1155/4626 compliance, storage layout, call graphs — with quick fixes and a CLI audit mode.",
  ],
  [
    "04",
    "DEPLOY & RUN",
    "One-click local chain",
    "Start Anvil, deploy from a dashboard, run forge scripts with keystores, get test CodeLens pass/fail inline — plus a contract playground and interactive notebooks.",
  ],
  [
    "05",
    "EVM TOOLBOX",
    "13 tools in the palette",
    "ABI & calldata encode/decode, event log and raw-tx decoding, unit converter, keccak, storage slots, CREATE2 addresses, epoch times, checksums — no browser tabs.",
  ],
  [
    "06",
    "INTEGRATIONS",
    "Your whole toolchain",
    "Foundry and Hardhat auto-detected; Slither, Mythril, Tenderly simulation, Cast, fork simulator and Etherscan verification wired into panels.",
  ],
];

function Features() {
  return (
    <section id="features" className="border-b-2 border-edge">
      <div className="mx-auto max-w-6xl px-5 py-16 lg:py-20">
        <Reveal>
          <div className="mb-3 font-mono text-xs tracking-[0.2em] text-muted">
            01 / WHAT IT DOES
          </div>
          <h2 className="mb-12 max-w-2xl text-4xl font-bold tracking-tight sm:text-5xl">
            The Solidity toolkit that lives{" "}
            <span className="bg-amber px-2 text-ink shadow-brut-sm">in the editor.</span>
          </h2>
        </Reveal>
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map(([num, tag, title, body], i) => (
            <Reveal
              key={num}
              delay={(i % 3) * 0.08}
              className="border-2 border-edge bg-surface p-6 shadow-brut transition-all hover:translate-x-[3px] hover:translate-y-[3px] hover:shadow-none"
            >
              <div className="mb-4 flex items-center justify-between">
                <span className="border-2 border-edge bg-accent-tint px-2 py-0.5 font-mono text-[11px] font-semibold text-accent-deep dark:bg-accent/10 dark:text-accent">
                  {tag}
                </span>
                <span className="font-mono text-xs text-muted">{num}</span>
              </div>
              <h3 className="mb-2 text-lg font-bold">{title}</h3>
              <p className="text-sm leading-relaxed text-body/70">{body}</p>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ---------- arsenal: everything inside ---------- */

/* each entry: [label, repo path] — the chip links straight to the source */
const ARSENAL: [string, [string, string][]][] = [
  [
    "GAS",
    [
      ["inline gas annotations", "src/features/gas-decorations.ts"],
      ["gas optimizer", "src/features/gas-optimizer.ts"],
      ["gas snapshots", "src/features/gas-snapshot.ts"],
      ["compare with branch", "src/features/regression.ts"],
      ["deployment cost", "src/features/gas.ts"],
      ["runtime profiler", "src/features/profiler.ts"],
      ["live gas prices", "src/features/gas-pricing.ts"],
      ["contract size", "src/features/size.ts"],
      ["complexity analysis", "src/features/complexity.ts"],
    ],
  ],
  [
    "DECODE & SELECTORS",
    [
      ["selector hover decode", "src/extension/providers/selector-hover-provider.ts"],
      ["4-byte lookup", "src/features/four-byte-lookup.ts"],
      ["collision detection", "src/features/collision-detector.ts"],
      ["event topic decode", "src/features/event-decoder.ts"],
      ["error selector decode", "src/core/parser.ts"],
      ["calldata decoder", "src/features/eth-tools/decoder.ts"],
      ["raw tx decoder", "src/features/remix-port/tx-format.ts"],
      ["event log decoder", "src/features/remix-port/events-decoder.ts"],
      ["signature database", "src/features/database.ts"],
      ["ABI export", "src/core/exporter.ts"],
    ],
  ],
  [
    "SECURITY",
    [
      ["reentrancy", "src/features/reentrancy-detector.ts"],
      ["unchecked calls", "src/features/unchecked-calls.ts"],
      ["access control", "src/features/access-control.ts"],
      ["missing events", "src/features/event-checker.ts"],
      ["natspec check", "src/features/natspec-checker.ts"],
      ["ERC-20/721/1155/4626 compliance", "src/features/interface-check.ts"],
      ["dangerous patterns", "src/features/dangerous-patterns.ts"],
      ["DeFi risk patterns", "src/features/defi-risks.ts"],
      ["MEV analysis", "src/features/mev-analyzer.ts"],
      ["invariant detection", "src/features/invariant-detector.ts"],
      ["upgrade compatibility", "src/features/upgrade-analyzer.ts"],
      ["storage layout", "src/features/storage-layout.ts"],
      ["call graph", "src/features/call-graph.ts"],
      ["custom error suggestions", "src/features/custom-error-suggestions.ts"],
      ["Slither", "src/features/slither-integration.ts"],
      ["Mythril", "src/features/mythril-integration.ts"],
    ],
  ],
  [
    "DEPLOY & RUN",
    [
      ["one-click Anvil", "src/features/anvil-manager.ts"],
      ["deploy dashboard", "src/extension/providers/deploy-run-provider.ts"],
      ["Foundry keystores", "src/features/keystore-discovery.ts"],
      ["forge script runner", "src/features/forge-script-runner.ts"],
      ["test CodeLens", "src/features/forge-test-runner.ts"],
      ["build diagnostics", "src/features/build-diagnostics.ts"],
      ["contract playground", "src/extension/providers/playground.ts"],
      ["interactive notebooks", "src/extension/providers/notebook-provider.ts"],
      ["fork simulator", "src/features/fork-simulator.ts"],
      ["Tenderly simulation", "src/features/tenderly-integration.ts"],
      ["Etherscan verify", "src/features/source-verifier.ts"],
      ["Cast", "src/features/cast-integration.ts"],
      ["Hardhat support", "src/features/hardhat-integration.ts"],
    ],
  ],
  [
    "EVM TOOLBOX",
    [
      ["ABI encode/decode", "src/features/eth-tools/encoder.ts"],
      ["calldata encode/decode", "src/features/eth-tools/decoder.ts"],
      ["unit converter", "src/features/eth-tools/units.ts"],
      ["keccak-256", "src/features/eth-tools/hash.ts"],
      ["storage slot calc", "src/features/eth-tools/slots.ts"],
      ["CREATE2 address", "src/features/eth-tools/address.ts"],
      ["epoch converter", "src/features/eth-tools/epoch.ts"],
      ["ETH constants", "src/features/eth-tools/constants.ts"],
      ["address inspector", "src/features/address-inspector.ts"],
    ],
  ],
  [
    "EDITOR",
    [
      ["Solidity snippets", "src/features/snippet-provider.ts"],
      ["quick fixes", "src/extension/providers/code-action-provider.ts"],
      ["contract flattener", "src/features/contract-flattener.ts"],
      ["chain explorer", "src/features/chain-explorer.ts"],
      ["remappings", "src/features/remappings.ts"],
      ["multi-version solc (download on demand)", "src/features/SolcManager.ts"],
      ["real-time file watcher", "src/core/watcher.ts"],
    ],
  ],
];

function Arsenal() {
  return (
    <section className="border-b-2 border-edge bg-dark dark:bg-panel">
      <div className="mx-auto max-w-6xl px-5 py-16 lg:py-20">
        <Reveal>
          <div className="mb-3 font-mono text-xs tracking-[0.2em] text-muted">
            02 / EVERYTHING INSIDE
          </div>
          <h2 className="mb-4 max-w-2xl text-4xl font-bold tracking-tight text-paper sm:text-5xl">
            101 commands.{" "}
            <span className="bg-accent px-2 text-ink shadow-brut-sm">
              One {VSIX_SIZE} VSIX.
            </span>
          </h2>
          <p className="mb-12 font-mono text-xs text-muted">
            nothing to hide — every chip links to its source file ↗
          </p>
        </Reveal>
        <div className="grid gap-5 md:grid-cols-2">
          {ARSENAL.map(([group, items], i) => (
            <Reveal key={group} delay={(i % 2) * 0.08} y={18}>
              <div className="border-2 border-paper/20 bg-dark p-5 dark:bg-[#101318]">
                <div className="mb-4 inline-block border-2 border-accent bg-accent/10 px-2 py-0.5 font-mono text-[11px] font-semibold tracking-widest text-accent">
                  {group}
                </div>
                <div className="flex flex-wrap gap-2">
                  {items.map(([label, path]) => (
                    <a
                      key={label}
                      href={`${GITHUB}/blob/main/${path}`}
                      target="_blank"
                      rel="noreferrer"
                      title={path}
                      className="border border-paper/25 px-2 py-1 font-mono text-[11px] text-paper/80 transition-colors hover:border-accent hover:bg-accent/10 hover:text-accent"
                    >
                      {label}
                    </a>
                  ))}
                </div>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ---------- AI agents ---------- */

const MCP_TOOLS = [
  "audit_solidity",
  "scan_signatures",
  "lookup_selector",
  "compute_selector",
  "decode_calldata",
  "encode_calldata",
  "abi_encode_params",
  "decode_raw_transaction",
  "keccak256",
  "convert_eth_units",
  "compute_contract_address",
  "storage_slot",
  "checksum_address",
  "eth_reference",
];

function AiAgents() {
  return (
    <section className="border-b-2 border-edge">
      <div className="mx-auto max-w-6xl px-5 py-16 lg:py-20">
        <Reveal>
          <div className="mb-3 font-mono text-xs tracking-[0.2em] text-muted">
            03 / BUILT FOR AI AGENTS
          </div>
          <h2 className="mb-4 max-w-3xl text-4xl font-bold tracking-tight sm:text-5xl">
            AI writes the contract.{" "}
            <span className="bg-accent px-2 text-ink shadow-brut-sm">
              0xTools keeps it honest.
            </span>
          </h2>
          <p className="mb-12 max-w-2xl text-body/70">
            Agents hallucinate selectors, gas numbers and security judgments.
            0xTools hands them deterministic ground truth instead — as an MCP
            server for Claude Code / Cursor, and as native Copilot agent tools
            inside VS Code. Every AI call is logged and flashed in the status
            bar; one setting turns it all off.
          </p>
        </Reveal>
        <div className="grid gap-6 lg:grid-cols-2">
          {/* agent transcript */}
          <Reveal>
            <div className="border-2 border-edge bg-panel font-mono text-[12.5px] leading-6 text-paper shadow-brut">
              <div className="border-b-2 border-ink bg-dark px-4 py-2 text-[11px] text-muted">
                claude — agent session
              </div>
              <div className="space-y-3 p-4">
                <p className="text-paper/85">
                  <span className="text-muted">&gt;</span> write a withdraw function for the
                  vault and make sure it&apos;s safe
                </p>
                <p className="text-muted">
                  ⏺ Writing Vault.withdraw()…{" "}
                  <span className="text-paper/60">then verifying with 0xTools</span>
                </p>
                <div className="border border-accent/40 bg-accent/5 px-3 py-2">
                  <p className="text-accent">⚒ audit_solidity(source: Vault.sol)</p>
                  <p className="text-amber">
                    ⚠ high · reentrancy · L7 — external call before state change
                  </p>
                </div>
                <p className="text-paper/85">
                  ⏺ Caught it — moving the balance write before the call
                  (checks-effects-interactions), re-auditing…{" "}
                  <span className="text-accent">✓ 0 high findings</span>
                </p>
                <div className="border border-paper/20 px-3 py-2 text-[11.5px]">
                  <p className="text-accent">⚒ compute_selector(&quot;withdraw(uint256)&quot;)</p>
                  <p className="text-paper/70">
                    → <span className="text-accent">0x2e1a7d4d</span> · quoted exactly, not
                    from memory
                  </p>
                </div>
              </div>
            </div>
          </Reveal>
          {/* hook it up */}
          <Reveal delay={0.1}>
            <div className="flex h-full flex-col gap-5">
              <div className="border-2 border-edge bg-surface p-5 shadow-brut">
                <div className="mb-2 font-mono text-[11px] font-semibold tracking-widest text-accent-deep">
                  MCP SERVER — CLAUDE CODE, CURSOR, ANY CLIENT
                </div>
                <pre className="whitespace-pre-wrap break-all border-2 border-ink bg-dark p-3 font-mono text-xs text-accent">
                  <code>claude mcp add 0xtools -- node ./dist/cli/index.js mcp</code>
                </pre>
                <p className="mt-3 text-sm leading-relaxed text-body/70">
                  14 tools over stdio. An agent skill ships in{" "}
                  <a
                    href={`${GITHUB}/blob/main/skills/0xtools/SKILL.md`}
                    target="_blank"
                    rel="noreferrer"
                    className="border-b border-accent text-accent-deep"
                  >
                    skills/0xtools
                  </a>{" "}
                  that teaches Claude when to call them.
                </p>
              </div>
              <div className="border-2 border-edge bg-surface p-5 shadow-brut">
                <div className="mb-2 font-mono text-[11px] font-semibold tracking-widest text-accent-deep">
                  COPILOT AGENT MODE — BUILT INTO THE VSIX
                </div>
                <p className="text-sm leading-relaxed text-body/70">
                  8 language-model tools (<code className="font-mono">#auditSolidity</code>,{" "}
                  <code className="font-mono">#computeSelector</code>…) register on install.
                  A status-bar strip lights on every AI call, the &ldquo;0xTools AI&rdquo;
                  output channel logs it, and{" "}
                  <code className="font-mono">sigscan.ai.enableTools</code> is the kill
                  switch.
                </p>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {MCP_TOOLS.map((t) => (
                  <span
                    key={t}
                    className="border border-edge/40 px-1.5 py-0.5 font-mono text-[10.5px] text-muted"
                  >
                    {t}
                  </span>
                ))}
              </div>
            </div>
          </Reveal>
        </div>
      </div>
    </section>
  );
}

/* ---------- install ---------- */

function Install() {
  return (
    <section id="install" className="border-b-2 border-edge bg-accent text-ink">
      <div className="mx-auto max-w-6xl px-5 py-16 lg:py-20">
        <Reveal>
          <div className="mb-3 font-mono text-xs tracking-[0.2em] text-ink/60">
            04 / INSTALL
          </div>
          <h2 className="mb-4 text-4xl font-bold tracking-tight sm:text-5xl">
            Three steps. No marketplace.
          </h2>
          <p className="mb-12 max-w-xl text-ink/70">
            We ship the VSIX directly while the marketplace listing is in the
            works. Same extension, zero middlemen.
          </p>
        </Reveal>
        <div className="grid gap-6 lg:grid-cols-3">
          <Reveal className="border-2 border-ink bg-paper p-6 shadow-brut">
            <div className="mb-3 inline-block border-2 border-ink bg-ink px-3 py-1 font-mono text-sm font-bold text-paper">
              STEP 1
            </div>
            <h3 className="mb-2 font-bold">Download the VSIX</h3>
            <a
              href={VSIX_PATH}
              download
              className="mt-2 inline-block border-2 border-ink bg-white px-4 py-2.5 font-mono text-xs font-semibold shadow-brut-sm transition-all hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-none"
            >
              ↓ 0xtools-{VERSION}.vsix
            </a>
          </Reveal>
          <Reveal delay={0.08} className="border-2 border-ink bg-paper p-6 shadow-brut">
            <div className="mb-3 inline-block border-2 border-ink bg-ink px-3 py-1 font-mono text-sm font-bold text-paper">
              STEP 2
            </div>
            <h3 className="mb-2 font-bold">Install it</h3>
            <pre className="mt-2 whitespace-pre-wrap break-all border-2 border-ink bg-dark p-3 font-mono text-xs text-accent">
              <code>code --install-extension 0xtools-{VERSION}.vsix</code>
            </pre>
            <p className="mt-3 font-mono text-[11px] leading-relaxed text-muted">
              or: Extensions panel → ··· menu → “Install from VSIX…”
            </p>
          </Reveal>
          <Reveal delay={0.16} className="border-2 border-ink bg-paper p-6 shadow-brut">
            <div className="mb-3 inline-block border-2 border-ink bg-ink px-3 py-1 font-mono text-sm font-bold text-paper">
              STEP 3
            </div>
            <h3 className="mb-2 font-bold">Open a .sol file</h3>
            <p className="text-sm leading-relaxed text-ink/70">
              Gas annotations, selector hovers and the{" "}
              <Strip className="inline h-4 w-4 align-text-bottom" /> activity-bar
              dashboard light up automatically.
            </p>
          </Reveal>
        </div>
      </div>
    </section>
  );
}

/* ---------- footer ---------- */

function Footer() {
  return (
    <footer className="bg-dark text-paper">
      <div className="mx-auto max-w-6xl px-5 py-14">
        <div className="flex flex-wrap items-center justify-between gap-8">
          <div className="flex items-center gap-4">
            <Strip className="h-12 w-12" stroke="#F4F4F1" />
            <img
              src="/brand/0xtools-wordmark-paper.svg"
              alt="0xTools"
              className="h-7 w-auto"
            />
          </div>
          <div className="flex items-center gap-6 font-mono text-sm">
            <a
              href={GITHUB}
              target="_blank"
              rel="noreferrer"
              className="border-b-2 border-transparent hover:border-accent"
            >
              GITHUB ↗
            </a>
            <a
              href={VSIX_PATH}
              download
              className="border-2 border-paper/25 bg-panel px-4 py-2 font-semibold transition-colors hover:border-accent"
            >
              GET .VSIX
            </a>
          </div>
        </div>
        <div className="mt-10 flex flex-wrap items-center justify-between gap-4 border-t border-paper/15 pt-6 font-mono text-xs text-muted">
          <span>0xTools · v{VERSION} · MIT license</span>
          <span>solidity · EVM · selector decoding · inline gas</span>
        </div>
      </div>
    </footer>
  );
}

export default function Home() {
  return (
    <main className="overflow-x-clip">
      <Ticker />
      <Nav />
      <Hero />
      <Stats />
      <Features />
      <Arsenal />
      <AiAgents />
      <Install />
      <Footer />
    </main>
  );
}
