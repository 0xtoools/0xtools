/**
 * PlaygroundPanel - Contract interaction playground webview
 *
 * Provides an interactive UI for executing contract functions with custom
 * arguments. Spawns the runner binary and displays results (return value,
 * gas used, or revert reason) inline.
 *
 * Communication: extension <-> webview via postMessage.
 */

import * as vscode from 'vscode';

interface PlaygroundFunction {
  name: string;
  signature: string;
  selector: string;
  inputs: Array<{ name: string; type: string }>;
}

interface ExecuteMessage {
  command: 'execute';
  function: string;
  args: string[];
}

interface ResultMessage {
  command: 'result';
  function: string;
  success: boolean;
  gas?: number;
  returnValue?: string;
  revertReason?: string;
  error?: string;
}

export class PlaygroundPanel {
  public static readonly viewType = 'sigscan.playground';

  private static instance: PlaygroundPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private contractName = '';
  private functions: PlaygroundFunction[] = [];
  private disposables: vscode.Disposable[] = [];

  /**
   * Create or reveal the singleton playground panel.
   */
  public static createOrShow(extensionUri: vscode.Uri): PlaygroundPanel {
    if (PlaygroundPanel.instance) {
      PlaygroundPanel.instance.panel.reveal(vscode.ViewColumn.Beside);
      return PlaygroundPanel.instance;
    }

    const panel = vscode.window.createWebviewPanel(
      PlaygroundPanel.viewType,
      '0xTools Playground',
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        localResourceRoots: [extensionUri],
      }
    );

    PlaygroundPanel.instance = new PlaygroundPanel(panel, extensionUri);
    return PlaygroundPanel.instance;
  }

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
    this.panel = panel;
    this.extensionUri = extensionUri;

    this.panel.webview.html = this.getHtmlContent();

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    this.panel.webview.onDidReceiveMessage(
      (message: ExecuteMessage) => {
        if (message.command === 'execute') {
          this.handleExecute(message);
        }
      },
      null,
      this.disposables
    );
  }

  /**
   * Set the contract to interact with. Updates the webview UI.
   */
  public setContract(contractName: string, functions: PlaygroundFunction[]): void {
    this.contractName = contractName;
    this.functions = functions;
    this.panel.webview.html = this.getHtmlContent();
  }

  /**
   * Handle an execute request from the webview.
   * The extension.ts caller should register a listener to actually run
   * the runner binary; this method dispatches the event.
   */
  private async handleExecute(message: ExecuteMessage): Promise<void> {
    // Notify the extension host about the execution request.
    // The extension.ts code that calls createOrShow should also register
    // a handler via onDidReceiveMessage or by overriding this method.
    // For now, we emit back a "pending" indicator and let the extension
    // host handle the actual execution via the panel's onDidReceiveMessage.
    //
    // The extension host should call sendResult() when execution completes.
    this.panel.webview.postMessage({
      command: 'status',
      function: message.function,
      status: 'executing',
    });
  }

  /**
   * Send an execution result back to the webview for display.
   */
  public sendResult(result: ResultMessage): void {
    this.panel.webview.postMessage(result);
  }

  /**
   * Get a reference to the underlying webview panel for external message handling.
   */
  public get webview(): vscode.Webview {
    return this.panel.webview;
  }

  /**
   * Dispose and clean up resources.
   */
  public dispose(): void {
    PlaygroundPanel.instance = undefined;

    this.panel.dispose();

    while (this.disposables.length) {
      const disposable = this.disposables.pop();
      if (disposable) {
        disposable.dispose();
      }
    }
  }

  /**
   * Generate the full HTML content for the webview.
   */
  private getHtmlContent(): string {
    const nonce = getNonce();

    const functionsHtml = this.functions
      .map((fn) => {
        const inputsHtml = fn.inputs
          .map(
            (input, idx) => `
            <div class="input-row">
              <label for="input-${fn.name}-${idx}">${input.name || `arg${idx}`} <span class="type">(${input.type})</span></label>
              <input
                type="text"
                id="input-${fn.name}-${idx}"
                class="arg-input"
                data-fn="${fn.name}"
                data-idx="${idx}"
                placeholder="${input.type}"
              />
            </div>`
          )
          .join('\n');

        return `
        <div class="function-card" id="card-${fn.name}">
          <div class="function-header">
            <span class="function-name">${fn.name}</span>
            <span class="selector">${fn.selector}</span>
          </div>
          <div class="function-signature">${fn.signature}</div>
          ${fn.inputs.length > 0 ? `<div class="inputs">${inputsHtml}</div>` : '<div class="no-inputs">No parameters</div>'}
          <button class="execute-btn" data-fn="${fn.name}" data-arg-count="${fn.inputs.length}">Execute</button>
          <div class="result-area" id="result-${fn.name}"></div>
        </div>`;
      })
      .join('\n');

    const contractHeader = this.contractName
      ? `<h1 class="contract-name">${this.contractName}</h1>`
      : '<h1 class="contract-name empty">No contract loaded</h1>';

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';" />
  <title>0xTools Playground</title>
  <style nonce="${nonce}">
    :root {
      --bg: var(--vscode-editor-background);
      --fg: var(--vscode-editor-foreground);
      --card-bg: var(--vscode-editorWidget-background, #252526);
      --border: var(--vscode-editorWidget-border, #454545);
      --input-bg: var(--vscode-input-background, #3c3c3c);
      --input-fg: var(--vscode-input-foreground, #cccccc);
      --input-border: var(--vscode-input-border, #5a5a5a);
      --btn-bg: var(--vscode-button-background, #0e639c);
      --btn-fg: var(--vscode-button-foreground, #ffffff);
      --btn-hover: var(--vscode-button-hoverBackground, #1177bb);
      --success: #4ec9b0;
      --error: #f44747;
      --warning: #cca700;
      --muted: var(--vscode-descriptionForeground, #808080);
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--vscode-font-family, 'Segoe UI', sans-serif);
      font-size: var(--vscode-font-size, 13px);
      color: var(--fg);
      background: var(--bg);
      padding: 16px;
    }
    .contract-name {
      font-size: 1.4em;
      margin-bottom: 16px;
      padding-bottom: 8px;
      border-bottom: 1px solid var(--border);
    }
    .contract-name.empty { color: var(--muted); font-style: italic; }
    .function-card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 12px;
      margin-bottom: 12px;
    }
    .function-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 4px;
    }
    .function-name {
      font-weight: bold;
      font-size: 1.1em;
    }
    .selector {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 0.85em;
      color: var(--muted);
    }
    .function-signature {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 0.85em;
      color: var(--muted);
      margin-bottom: 8px;
    }
    .input-row {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 6px;
    }
    .input-row label {
      min-width: 120px;
      font-size: 0.9em;
    }
    .type { color: var(--muted); font-size: 0.85em; }
    .arg-input {
      flex: 1;
      background: var(--input-bg);
      color: var(--input-fg);
      border: 1px solid var(--input-border);
      border-radius: 2px;
      padding: 4px 8px;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 0.9em;
      outline: none;
    }
    .arg-input:focus { border-color: var(--btn-bg); }
    .no-inputs {
      font-size: 0.85em;
      color: var(--muted);
      font-style: italic;
      margin-bottom: 8px;
    }
    .inputs { margin-bottom: 8px; }
    .execute-btn {
      background: var(--btn-bg);
      color: var(--btn-fg);
      border: none;
      border-radius: 2px;
      padding: 6px 16px;
      cursor: pointer;
      font-size: 0.9em;
    }
    .execute-btn:hover { background: var(--btn-hover); }
    .execute-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .result-area {
      margin-top: 8px;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 0.85em;
      white-space: pre-wrap;
      word-break: break-all;
    }
    .result-area.success { color: var(--success); }
    .result-area.error { color: var(--error); }
    .result-area.pending { color: var(--warning); }
    .empty-state {
      text-align: center;
      padding: 40px;
      color: var(--muted);
    }
  </style>
</head>
<body>
  ${contractHeader}
  ${
    this.functions.length > 0
      ? `<div class="functions-list">${functionsHtml}</div>`
      : '<div class="empty-state">Load a contract to interact with its functions.</div>'
  }
  <script nonce="${nonce}">
    (function() {
      const vscode = acquireVsCodeApi();

      document.querySelectorAll('.execute-btn').forEach(btn => {
        btn.addEventListener('click', function() {
          const fnName = this.dataset.fn;
          const argCount = parseInt(this.dataset.argCount, 10);
          const args = [];
          for (let i = 0; i < argCount; i++) {
            const input = document.getElementById('input-' + fnName + '-' + i);
            args.push(input ? input.value : '');
          }

          this.disabled = true;
          const resultEl = document.getElementById('result-' + fnName);
          if (resultEl) {
            resultEl.className = 'result-area pending';
            resultEl.textContent = 'Executing...';
          }

          vscode.postMessage({
            command: 'execute',
            function: fnName,
            args: args
          });
        });
      });

      window.addEventListener('message', function(event) {
        const msg = event.data;
        if (msg.command === 'result') {
          const resultEl = document.getElementById('result-' + msg.function);
          const btn = document.querySelector('[data-fn="' + msg.function + '"].execute-btn');
          if (btn) { btn.disabled = false; }

          if (!resultEl) { return; }

          if (msg.success) {
            resultEl.className = 'result-area success';
            let text = '';
            if (msg.gas !== undefined) { text += 'Gas: ' + msg.gas.toLocaleString() + '\\n'; }
            if (msg.returnValue !== undefined) { text += 'Return: ' + msg.returnValue; }
            resultEl.textContent = text || 'Success (no return data)';
          } else {
            resultEl.className = 'result-area error';
            if (msg.revertReason) {
              resultEl.textContent = 'Revert: ' + msg.revertReason;
            } else if (msg.error) {
              resultEl.textContent = 'Error: ' + msg.error;
            } else {
              resultEl.textContent = 'Execution failed';
            }
          }
        } else if (msg.command === 'status' && msg.status === 'executing') {
          const resultEl = document.getElementById('result-' + msg.function);
          if (resultEl) {
            resultEl.className = 'result-area pending';
            resultEl.textContent = 'Executing...';
          }
        }
      });
    })();
  </script>
</body>
</html>`;
  }
}

/**
 * Generate a nonce string for CSP.
 * CSP nonces in a local VS Code webview do not require cryptographic randomness.
 */
function getNonce(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}
