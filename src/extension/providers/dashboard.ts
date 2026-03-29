/**
 * DashboardPanel - Solidity metrics dashboard webview
 *
 * Displays aggregated project metrics including contract counts, gas
 * distribution, complexity breakdown, largest contracts, and interface
 * compliance status in a single dashboard view.
 *
 * All rendering uses plain text-based tables/lists with monospace font
 * and inline CSS color highlights. No external chart libraries.
 */

import * as vscode from 'vscode';

export interface DashboardData {
  totalContracts: number;
  totalFunctions: number;
  totalEvents: number;
  totalErrors: number;
  gasDistribution: Array<{ range: string; count: number }>;
  complexityDistribution: Array<{ level: string; count: number }>;
  largestContracts: Array<{ name: string; functions: number; size?: number }>;
  interfaceCompliance: Array<{ contract: string; interfaces: string[] }>;
}

export class DashboardPanel {
  public static readonly viewType = 'sigscan.dashboard';

  private static instance: DashboardPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private data: DashboardData | null = null;
  private disposables: vscode.Disposable[] = [];

  /**
   * Create or reveal the singleton dashboard panel.
   */
  public static createOrShow(extensionUri: vscode.Uri): DashboardPanel {
    if (DashboardPanel.instance) {
      DashboardPanel.instance.panel.reveal(vscode.ViewColumn.Beside);
      return DashboardPanel.instance;
    }

    const panel = vscode.window.createWebviewPanel(
      DashboardPanel.viewType,
      '0xTools Dashboard',
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        localResourceRoots: [extensionUri],
      }
    );

    DashboardPanel.instance = new DashboardPanel(panel, extensionUri);
    return DashboardPanel.instance;
  }

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
    this.panel = panel;
    this.extensionUri = extensionUri;

    this.panel.webview.html = this.getHtmlContent();

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  /**
   * Update the dashboard with new metrics data.
   */
  public updateMetrics(data: DashboardData): void {
    this.data = data;
    this.panel.webview.html = this.getHtmlContent();
  }

  /**
   * Dispose and clean up resources.
   */
  public dispose(): void {
    DashboardPanel.instance = undefined;

    this.panel.dispose();

    while (this.disposables.length) {
      const disposable = this.disposables.pop();
      if (disposable) {
        disposable.dispose();
      }
    }
  }

  // ---------------------------------------------------------------------------
  // HTML Generation
  // ---------------------------------------------------------------------------

  private getHtmlContent(): string {
    const nonce = getNonce();

    const body = this.data ? this.renderDashboard(this.data) : this.renderEmpty();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';" />
  <title>0xTools Dashboard</title>
  <style nonce="${nonce}">
    :root {
      --bg: var(--vscode-editor-background);
      --fg: var(--vscode-editor-foreground);
      --card-bg: var(--vscode-editorWidget-background, #252526);
      --border: var(--vscode-editorWidget-border, #454545);
      --muted: var(--vscode-descriptionForeground, #808080);
      --green: #4ec9b0;
      --yellow: #dcdcaa;
      --orange: #ce9178;
      --red: #f44747;
      --blue: #569cd6;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--vscode-editor-font-family, 'Consolas', 'Courier New', monospace);
      font-size: var(--vscode-editor-font-size, 13px);
      color: var(--fg);
      background: var(--bg);
      padding: 16px;
      line-height: 1.5;
    }
    h1 {
      font-size: 1.4em;
      margin-bottom: 16px;
      padding-bottom: 8px;
      border-bottom: 1px solid var(--border);
    }
    h2 {
      font-size: 1.1em;
      margin: 16px 0 8px 0;
      color: var(--blue);
    }
    .summary-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
      gap: 12px;
      margin-bottom: 20px;
    }
    .summary-card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 12px;
      text-align: center;
    }
    .summary-card .value {
      font-size: 2em;
      font-weight: bold;
    }
    .summary-card .label {
      font-size: 0.85em;
      color: var(--muted);
      margin-top: 4px;
    }
    .card-contracts .value { color: var(--blue); }
    .card-functions .value { color: var(--green); }
    .card-events .value { color: var(--yellow); }
    .card-errors .value { color: var(--red); }

    table {
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 16px;
    }
    th, td {
      text-align: left;
      padding: 6px 12px;
      border-bottom: 1px solid var(--border);
    }
    th {
      color: var(--muted);
      font-weight: normal;
      font-size: 0.85em;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    td.num { text-align: right; font-variant-numeric: tabular-nums; }
    tr:hover { background: rgba(255,255,255,0.03); }

    .bar-cell {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .bar {
      height: 14px;
      border-radius: 2px;
      min-width: 2px;
    }
    .bar-label {
      font-size: 0.85em;
      min-width: 30px;
      text-align: right;
    }

    .gas-low { background: var(--green); }
    .gas-medium { background: var(--yellow); }
    .gas-high { background: var(--orange); }
    .gas-very-high { background: var(--red); }

    .complexity-low { color: var(--green); }
    .complexity-medium { color: var(--yellow); }
    .complexity-high { color: var(--orange); }
    .complexity-very-high { color: var(--red); }

    .interface-list {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
    }
    .interface-tag {
      background: rgba(86, 156, 214, 0.2);
      color: var(--blue);
      padding: 2px 8px;
      border-radius: 3px;
      font-size: 0.85em;
    }

    .empty-state {
      text-align: center;
      padding: 60px 20px;
      color: var(--muted);
    }
    .empty-state p { margin-top: 8px; }

    .section {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 12px;
      margin-bottom: 16px;
    }
  </style>
</head>
<body>
  ${body}
</body>
</html>`;
  }

  private renderEmpty(): string {
    return `
      <h1>0xTools Dashboard</h1>
      <div class="empty-state">
        <p>No metrics data available.</p>
        <p>Run "0xTools: Scan Project" to populate the dashboard.</p>
      </div>`;
  }

  private renderDashboard(data: DashboardData): string {
    return `
      <h1>0xTools Dashboard</h1>

      ${this.renderSummaryCards(data)}
      ${this.renderGasDistribution(data.gasDistribution)}
      ${this.renderComplexityDistribution(data.complexityDistribution)}
      ${this.renderLargestContracts(data.largestContracts)}
      ${this.renderInterfaceCompliance(data.interfaceCompliance)}
    `;
  }

  private renderSummaryCards(data: DashboardData): string {
    return `
      <div class="summary-grid">
        <div class="summary-card card-contracts">
          <div class="value">${data.totalContracts}</div>
          <div class="label">Contracts</div>
        </div>
        <div class="summary-card card-functions">
          <div class="value">${data.totalFunctions}</div>
          <div class="label">Functions</div>
        </div>
        <div class="summary-card card-events">
          <div class="value">${data.totalEvents}</div>
          <div class="label">Events</div>
        </div>
        <div class="summary-card card-errors">
          <div class="value">${data.totalErrors}</div>
          <div class="label">Errors</div>
        </div>
      </div>`;
  }

  private renderGasDistribution(distribution: Array<{ range: string; count: number }>): string {
    if (distribution.length === 0) {
      return '';
    }

    const maxCount = Math.max(...distribution.map((d) => d.count), 1);

    const rows = distribution
      .map((entry) => {
        const pct = Math.round((entry.count / maxCount) * 100);
        const barClass = this.gasRangeClass(entry.range);
        return `
          <tr>
            <td>${entry.range}</td>
            <td>
              <div class="bar-cell">
                <div class="bar ${barClass}" style="width: ${Math.max(pct, 2)}%;"></div>
                <span class="bar-label">${entry.count}</span>
              </div>
            </td>
          </tr>`;
      })
      .join('\n');

    return `
      <div class="section">
        <h2>Gas Distribution</h2>
        <table>
          <thead><tr><th>Range</th><th>Count</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  }

  private renderComplexityDistribution(
    distribution: Array<{ level: string; count: number }>
  ): string {
    if (distribution.length === 0) {
      return '';
    }

    const rows = distribution
      .map((entry) => {
        const cssClass = this.complexityLevelClass(entry.level);
        return `
          <tr>
            <td class="${cssClass}">${entry.level}</td>
            <td class="num">${entry.count}</td>
          </tr>`;
      })
      .join('\n');

    return `
      <div class="section">
        <h2>Complexity Breakdown</h2>
        <table>
          <thead><tr><th>Level</th><th>Count</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  }

  private renderLargestContracts(
    contracts: Array<{ name: string; functions: number; size?: number }>
  ): string {
    if (contracts.length === 0) {
      return '';
    }

    // Show top 10
    const top10 = contracts.slice(0, 10);
    const hasSize = top10.some((c) => c.size !== undefined);

    const headerSize = hasSize ? '<th>Size (bytes)</th>' : '';
    const rows = top10
      .map((c, idx) => {
        const sizeCell = hasSize
          ? `<td class="num">${c.size !== undefined ? c.size.toLocaleString() : '-'}</td>`
          : '';
        return `
          <tr>
            <td class="num">${idx + 1}</td>
            <td>${c.name}</td>
            <td class="num">${c.functions}</td>
            ${sizeCell}
          </tr>`;
      })
      .join('\n');

    return `
      <div class="section">
        <h2>Top 10 Largest Contracts</h2>
        <table>
          <thead><tr><th>#</th><th>Contract</th><th>Functions</th>${headerSize}</tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  }

  private renderInterfaceCompliance(
    compliance: Array<{ contract: string; interfaces: string[] }>
  ): string {
    if (compliance.length === 0) {
      return '';
    }

    const rows = compliance
      .map((entry) => {
        const tags = entry.interfaces
          .map((iface) => `<span class="interface-tag">${escapeHtml(iface)}</span>`)
          .join(' ');
        return `
          <tr>
            <td>${escapeHtml(entry.contract)}</td>
            <td><div class="interface-list">${tags}</div></td>
          </tr>`;
      })
      .join('\n');

    return `
      <div class="section">
        <h2>Interface Compliance</h2>
        <table>
          <thead><tr><th>Contract</th><th>Implements</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private gasRangeClass(range: string): string {
    const lower = range.toLowerCase();
    if (lower.includes('>500') || lower.includes('500k')) {
      return 'gas-very-high';
    }
    if (lower.includes('150') || lower.includes('150-') || lower.includes('150k')) {
      return 'gas-high';
    }
    if (lower.includes('50') || lower.includes('50-') || lower.includes('50k')) {
      return 'gas-medium';
    }
    return 'gas-low';
  }

  private complexityLevelClass(level: string): string {
    const lower = level.toLowerCase();
    if (lower.includes('very') || lower.includes('critical')) {
      return 'complexity-very-high';
    }
    if (lower.includes('high')) {
      return 'complexity-high';
    }
    if (lower.includes('medium') || lower.includes('moderate')) {
      return 'complexity-medium';
    }
    return 'complexity-low';
  }
}

/**
 * Generate a nonce string for CSP.
 * CSP nonces in a local VS Code webview do not require cryptographic randomness.
 */
function getNonce(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/**
 * Escape HTML special characters to prevent injection.
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
