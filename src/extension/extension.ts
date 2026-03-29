/* eslint-disable @typescript-eslint/no-var-requires */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { SigScanManager } from './manager';
import { SignatureTreeProvider } from './providers/treeProvider';
import { logger } from '../utils/logger';

let sigScanManager: SigScanManager;
let signatureTreeProvider: SignatureTreeProvider;

// RealtimeAnalyzer — lazy loaded at first use (type-only import for annotations)
import type { RealtimeAnalyzer } from '../features/realtime';

// New Remix-style compilation imports
import { compilationService } from '../features/compilation-service';
import { GasDecorationManager } from '../features/gas-decorations';

// SelectorHoverProvider is eagerly loaded (used for frequent hover events)
import { SelectorHoverProvider } from './providers/selector-hover-provider';
// Notebook provider — lazy loaded when registering serializer/controller
type NotebookProviderModule = typeof import('./providers/notebook-provider');

// RemappingsResolver and ForgeTestCodeLensProvider — lazy loaded at point-of-use

let realtimeAnalyzer: RealtimeAnalyzer;
let gasDecorationType: vscode.TextEditorDecorationType;
let complexityDecorationType: vscode.TextEditorDecorationType;
let remixGasDecorationType: vscode.TextEditorDecorationType;
let statusBarItem: vscode.StatusBarItem;
let gasDecorationManager: GasDecorationManager;

// Lazy-loaded singletons for long-running services
let _anvilManager: InstanceType<typeof import('../features/anvil-manager').AnvilManager> | null =
  null;
let _forkSimulator: InstanceType<typeof import('../features/fork-simulator').ForkSimulator> | null =
  null;

// Singleton RPC provider — shared across all on-chain commands
let _rpcProvider: InstanceType<typeof import('../features/rpc-provider').RpcProvider> | null = null;
function getRpcProvider(): InstanceType<typeof import('../features/rpc-provider').RpcProvider> {
  if (!_rpcProvider) {
    const { RpcProvider } = require('../features/rpc-provider');
    _rpcProvider = new RpcProvider();
    applyCustomRpcEndpoints(_rpcProvider);
  }
  return _rpcProvider!;
}

/** Apply user-configured custom RPC endpoints */
function applyCustomRpcEndpoints(rpc: any): void {
  try {
    const vsc = require('vscode');
    const config = vsc.workspace.getConfiguration('sigscan');
    const custom: Record<string, string> = config.get('rpc.customEndpoints', {});
    for (const [chain, url] of Object.entries(custom)) {
      if (url) {
        rpc.setEndpoint(chain, url);
      }
    }
  } catch {
    /* not in vscode context */
  }
}

export function activate(context: vscode.ExtensionContext) {
  // Initialize structured logger
  logger.init(context);
  logger.info('0xTools extension activated');

  // Initialize manager
  sigScanManager = new SigScanManager(context);
  signatureTreeProvider = new SignatureTreeProvider(sigScanManager);

  // Initialize real-time analyzer (lazy-loaded)
  const diagnosticCollection = vscode.languages.createDiagnosticCollection('sigscan');
  const { RealtimeAnalyzer } = require('../features/realtime');
  realtimeAnalyzer = new RealtimeAnalyzer(diagnosticCollection);

  // Initialize Remix-style gas decoration manager
  gasDecorationManager = GasDecorationManager.getInstance(300); // 300ms debounce

  // Remappings resolver — lazy-loaded on first compilation
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  let _remappingsResolver: any = null;
  function getRemappingsResolver() {
    if (!_remappingsResolver) {
      const { RemappingsResolver } = require('../features/remappings');
      _remappingsResolver = new RemappingsResolver();
      if (workspaceRoot) {
        _remappingsResolver.load(workspaceRoot);
      }
    }
    return _remappingsResolver;
  }

  // Forge test CodeLens provider — lazy-loaded on first use
  let _forgeTestProvider: any = null;
  function getForgeTestProvider() {
    if (!_forgeTestProvider) {
      const { ForgeTestCodeLensProvider } = require('../features/forge-test-runner');
      _forgeTestProvider = new ForgeTestCodeLensProvider();
    }
    return _forgeTestProvider;
  }
  const codeLensDisposable = vscode.languages.registerCodeLensProvider(
    { scheme: 'file', language: 'solidity' },
    { provideCodeLenses: (doc, token) => getForgeTestProvider().provideCodeLenses(doc, token) }
  );

  // Create decoration types for gas and complexity hints
  // IMPORTANT: Need at least an empty 'after' object for dynamic renderOptions to work
  gasDecorationType = vscode.window.createTextEditorDecorationType({
    after: {
      margin: '0 0 0 1em',
      fontWeight: 'bold',
    },
    isWholeLine: false,
  });
  complexityDecorationType = vscode.window.createTextEditorDecorationType({
    after: {
      margin: '0 0 0 1em',
    },
  });
  remixGasDecorationType = vscode.window.createTextEditorDecorationType({
    after: {
      color: '#73E068',
      fontWeight: 'bold',
      margin: '0 0 0 1em',
    },
  });

  // Create status bar item
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.text = '$(flame) Gas Analysis';
  statusBarItem.tooltip = '0xTools: Real-time gas analysis active';
  statusBarItem.command = 'sigscan.toggleRealtimeAnalysis';
  const initialConfig = vscode.workspace.getConfiguration('sigscan');
  if (initialConfig.get('realtimeAnalysis', true)) {
    statusBarItem.show();
  }

  // Listen for Remix-style compilation events
  compilationService.on('compilation:start', ({ uri, version }) => {
    if (version === 'runner') {
      logger.info(`Analyzing ${uri} with sigscan-runner`);
      statusBarItem.text = '$(zap~spin) Running EVM...';
    } else if (version === 'forge') {
      logger.info(`Building ${uri} with forge`);
      statusBarItem.text = '$(tools~spin) Forge building...';
    } else {
      logger.info(`Compiling ${uri} with solc ${version}`);
      statusBarItem.text = '$(sync~spin) Compiling...';
    }
  });

  compilationService.on('compilation:success', ({ uri, output }) => {
    logger.info(`Compilation successful: ${output.gasInfo.length} functions analyzed`);
    statusBarItem.text = '$(flame) Gas Analysis';

    // Safety net: apply decorations from event in case the updateDecorations() caller
    // missed this result (e.g. editor switched mid-compilation)
    if (output.gasInfo.length > 0) {
      const editor = vscode.window.visibleTextEditors.find(
        (e) => e.document.uri.toString() === uri
      );
      if (editor) {
        const decorations = realtimeAnalyzer.createRemixStyleDecorations(
          output.gasInfo,
          editor.document
        );
        editor.setDecorations(gasDecorationType, decorations);
      }
    }
  });

  compilationService.on('compilation:error', ({ errors }) => {
    logger.error(`Compilation failed: ${errors[0]}`);
    statusBarItem.text = '$(flame) Gas Analysis';
  });

  compilationService.on('version:downloading', ({ version }) => {
    statusBarItem.text = `$(cloud-download) Downloading solc ${version}...`;
    vscode.window.setStatusBarMessage(`Downloading Solidity compiler ${version}...`, 5000);
  });

  compilationService.on('version:ready', ({ version }) => {
    statusBarItem.text = '$(flame) Gas Analysis';
    vscode.window.setStatusBarMessage(`Solidity compiler ${version} ready`, 3000);
  });

  // Register tree view
  const treeView = vscode.window.createTreeView('sigScanExplorer', {
    treeDataProvider: signatureTreeProvider,
    showCollapseAll: true,
  });

  // Register commands
  const commands = [
    vscode.commands.registerCommand('sigscan.scanProject', () => {
      sigScanManager.scanProject();
    }),

    vscode.commands.registerCommand('sigscan.startWatching', () => {
      sigScanManager.startWatching();
      vscode.window.showInformationMessage('0xTools: Started watching for file changes');
    }),

    vscode.commands.registerCommand('sigscan.stopWatching', () => {
      sigScanManager.stopWatching();
      vscode.window.showInformationMessage('0xTools: Stopped watching for file changes');
    }),

    vscode.commands.registerCommand('sigscan.exportSignatures', async () => {
      await sigScanManager.exportSignatures();
    }),

    vscode.commands.registerCommand('sigscan.refreshSignatures', () => {
      sigScanManager.refreshSignatures();
      signatureTreeProvider.refresh();
    }),

    vscode.commands.registerCommand('sigscan.copySignature', (signature: string) => {
      vscode.env.clipboard.writeText(signature);
      vscode.window.showInformationMessage(`Copied: ${signature}`);
    }),

    vscode.commands.registerCommand('sigscan.copySelector', (selector: string) => {
      vscode.env.clipboard.writeText(selector);
      vscode.window.showInformationMessage(`Copied: ${selector}`);
    }),

    vscode.commands.registerCommand('sigscan.generateABI', async () => {
      await sigScanManager.generateABI();
    }),

    vscode.commands.registerCommand('sigscan.estimateGas', async () => {
      await sigScanManager.estimateGas();
    }),

    vscode.commands.registerCommand('sigscan.checkContractSize', async () => {
      await sigScanManager.checkContractSize();
    }),

    vscode.commands.registerCommand('sigscan.analyzeComplexity', async () => {
      await sigScanManager.analyzeComplexity();
    }),

    vscode.commands.registerCommand('sigscan.verifyEtherscan', async () => {
      await sigScanManager.verifyEtherscan();
    }),

    vscode.commands.registerCommand('sigscan.searchDatabase', async () => {
      await sigScanManager.searchDatabase();
    }),

    vscode.commands.registerCommand('sigscan.generateAllReports', async () => {
      await sigScanManager.generateAllReports();
    }),

    vscode.commands.registerCommand('sigscan.toggleRealtimeAnalysis', () => {
      const config = vscode.workspace.getConfiguration('sigscan');
      const enabled = config.get('realtimeAnalysis', true);
      config.update('realtimeAnalysis', !enabled, vscode.ConfigurationTarget.Workspace);
      if (!enabled) {
        statusBarItem.show();
        // Trigger immediate analysis
        if (vscode.window.activeTextEditor) {
          updateDecorations(vscode.window.activeTextEditor);
        }
      } else {
        statusBarItem.hide();
      }
      vscode.window.showInformationMessage(
        `Real-time gas analysis ${!enabled ? 'enabled' : 'disabled'}`
      );
    }),

    vscode.commands.registerCommand('sigscan.showGasAnnotations', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage('No active editor');
        return;
      }
      if (editor.document.languageId !== 'solidity') {
        vscode.window.showWarningMessage('Not a Solidity file');
        return;
      }
      await updateDecorations(editor);
      vscode.window.showInformationMessage('Gas annotations updated!');
    }),
  ];

  // ─── New feature commands (Phase 6-9) ────────────────────────────────────

  const selectorHoverProvider = new SelectorHoverProvider();

  const newCommands = [
    // Collision detection
    vscode.commands.registerCommand('sigscan.detectCollisions', async () => {
      const scanResult = sigScanManager.getLastScanResult();
      if (!scanResult) {
        vscode.window.showWarningMessage('No contracts scanned yet. Run "Scan Project" first.');
        return;
      }
      const contracts = new Map<string, import('../types').ContractInfo>();
      scanResult.contractsByCategory.forEach((infos) => {
        for (const info of infos) {
          contracts.set(info.name, info);
        }
      });
      const { CollisionDetector } = require('../features/collision-detector');
      const collisionDetector = new CollisionDetector();
      const collisions = collisionDetector.detectCollisions(contracts);
      const report = collisionDetector.generateReport(collisions);
      const doc = await vscode.workspace.openTextDocument({
        content: report,
        language: 'markdown',
      });
      await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
    }),

    // Interface compliance
    vscode.commands.registerCommand('sigscan.checkInterfaces', async () => {
      const scanResult = sigScanManager.getLastScanResult();
      if (!scanResult) {
        vscode.window.showWarningMessage('No contracts scanned yet. Run "Scan Project" first.');
        return;
      }
      const contracts = new Map<string, import('../types').ContractInfo>();
      scanResult.contractsByCategory.forEach((infos) => {
        for (const info of infos) {
          contracts.set(info.name, info);
        }
      });
      const { InterfaceChecker } = require('../features/interface-check');
      const interfaceChecker = new InterfaceChecker();
      const allResults = interfaceChecker.checkAllContracts(contracts);
      const parts: string[] = ['# Interface Compliance Report\n'];
      allResults.forEach((results: any, contractName: string) => {
        parts.push(interfaceChecker.generateReport(contractName, results));
      });
      const doc = await vscode.workspace.openTextDocument({
        content: parts.join('\n'),
        language: 'markdown',
      });
      await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
    }),

    // Gas optimizer
    vscode.commands.registerCommand('sigscan.suggestOptimizations', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.languageId !== 'solidity') {
        vscode.window.showErrorMessage('Open a Solidity file to analyze');
        return;
      }
      const { GasOptimizer } = require('../features/gas-optimizer');
      const gasOptimizer = new GasOptimizer();
      const suggestions = gasOptimizer.analyze(editor.document.getText());
      const report = gasOptimizer.generateReport(
        suggestions,
        path.basename(editor.document.uri.fsPath)
      );
      const doc = await vscode.workspace.openTextDocument({
        content: report,
        language: 'markdown',
      });
      await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
    }),

    // Coverage
    vscode.commands.registerCommand('sigscan.showCoverage', async () => {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) {
        vscode.window.showErrorMessage('No workspace folder open');
        return;
      }
      const { CoverageAnalyzer } = require('../features/coverage');
      const coverageAnalyzer = new CoverageAnalyzer();
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Parsing coverage data...' },
        async () => {
          const coverageReport = await coverageAnalyzer.parseForgeCoverage(
            workspaceFolder.uri.fsPath
          );
          if (!coverageReport) {
            vscode.window.showWarningMessage(
              'No coverage data found. Run `forge coverage --report lcov` first.'
            );
            return;
          }
          const report = coverageAnalyzer.generateReport(coverageReport);
          const doc = await vscode.workspace.openTextDocument({
            content: report,
            language: 'markdown',
          });
          await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
        }
      );
    }),

    // Upgrade analysis
    vscode.commands.registerCommand('sigscan.analyzeUpgrade', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.languageId !== 'solidity') {
        vscode.window.showErrorMessage('Open a Solidity file (new version) to compare');
        return;
      }
      const oldFile = await vscode.window.showOpenDialog({
        canSelectMany: false,
        filters: { Solidity: ['sol'] },
        openLabel: 'Select Old Version',
      });
      if (!oldFile || oldFile.length === 0) {
        return;
      }
      const oldSource = fs.readFileSync(oldFile[0].fsPath, 'utf-8');
      const newSource = editor.document.getText();
      const contractMatch = newSource.match(/(contract|library)\s+(\w+)/);
      const contractName = contractMatch ? contractMatch[2] : 'Unknown';
      const { UpgradeAnalyzer } = require('../features/upgrade-analyzer');
      const upgradeAnalyzer = new UpgradeAnalyzer();
      const report = upgradeAnalyzer.analyzeUpgrade(oldSource, newSource, contractName);
      const reportStr = upgradeAnalyzer.generateReport(report);
      const doc = await vscode.workspace.openTextDocument({
        content: reportStr,
        language: 'markdown',
      });
      await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
    }),

    // Invariant detection
    vscode.commands.registerCommand('sigscan.detectInvariants', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.languageId !== 'solidity') {
        vscode.window.showErrorMessage('Open a Solidity file to analyze');
        return;
      }
      const { InvariantDetector } = require('../features/invariant-detector');
      const invariantDetector = new InvariantDetector();
      const invariants = invariantDetector.detect(editor.document.getText());
      const lines = ['# Invariant Detection Report\n'];
      if (invariants.length === 0) {
        lines.push('No invariants detected.\n');
      }
      for (const inv of invariants) {
        lines.push(`## ${inv.type}\n`);
        lines.push(`**Description:** ${inv.description}\n`);
        lines.push(`**Confidence:** ${inv.confidence}\n`);
        if (inv.line) {
          lines.push(`**Line:** ${inv.line}\n`);
        }
        lines.push('');
      }
      const doc = await vscode.workspace.openTextDocument({
        content: lines.join('\n'),
        language: 'markdown',
      });
      await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
    }),

    // MEV analysis
    vscode.commands.registerCommand('sigscan.analyzeMEV', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.languageId !== 'solidity') {
        vscode.window.showErrorMessage('Open a Solidity file to analyze');
        return;
      }
      const { MEVAnalyzer } = require('../features/mev-analyzer');
      const mevAnalyzer = new MEVAnalyzer();
      const risks = mevAnalyzer.analyze(editor.document.getText());
      const lines = ['# MEV Risk Analysis\n'];
      if (risks.length === 0) {
        lines.push('No MEV risks detected.\n');
      }
      for (const risk of risks) {
        lines.push(`## ${risk.riskType} (${risk.functionName})\n`);
        lines.push(`**Description:** ${risk.description}\n`);
        lines.push(`**Severity:** ${risk.severity}\n`);
        if (risk.line) {
          lines.push(`**Line:** ${risk.line}\n`);
        }
        if (risk.mitigation) {
          lines.push(`**Mitigation:** ${risk.mitigation}\n`);
        }
        lines.push('');
      }
      const doc = await vscode.workspace.openTextDocument({
        content: lines.join('\n'),
        language: 'markdown',
      });
      await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
    }),

    // Gas snapshot
    vscode.commands.registerCommand('sigscan.createGasSnapshot', async () => {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) {
        vscode.window.showErrorMessage('No workspace folder open');
        return;
      }
      const scanResult = sigScanManager.getLastScanResult();
      if (!scanResult) {
        vscode.window.showWarningMessage('No contracts scanned. Run "Scan Project" first.');
        return;
      }
      const gasData: Array<{
        contractName: string;
        functionName: string;
        selector: string;
        gas: number;
      }> = [];
      scanResult.contractsByCategory.forEach((infos) => {
        for (const info of infos) {
          for (const fn of info.functions) {
            gasData.push({
              contractName: info.name,
              functionName: fn.name,
              selector: fn.selector,
              gas: 0,
            });
          }
        }
      });
      const { GasSnapshotManager } = require('../features/gas-snapshot');
      const gasSnapshotManager = new GasSnapshotManager();
      const snapshot = await gasSnapshotManager.createSnapshot(gasData, workspaceFolder.uri.fsPath);
      const filePath = path.join(workspaceFolder.uri.fsPath, '.sigscan-snapshot.json');
      gasSnapshotManager.exportSnapshot(snapshot, filePath);
      vscode.window.showInformationMessage(`Gas snapshot saved to ${filePath}`);
    }),

    // Gas pricing
    vscode.commands.registerCommand('sigscan.showGasPricing', async () => {
      const { GasPricingService } = require('../features/gas-pricing');
      const gasPricingService = new GasPricingService();
      const chains = gasPricingService.getSupportedChains();
      const chain = await vscode.window.showQuickPick(chains, { placeHolder: 'Select chain' });
      if (!chain) {
        return;
      }
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Fetching ${chain} gas prices...`,
        },
        async () => {
          const price = await gasPricingService.fetchGasPrice(chain);
          if (!price) {
            vscode.window.showWarningMessage(`Could not fetch gas prices for ${chain}`);
            return;
          }
          const lines = [
            `# Gas Prices: ${chain}\n`,
            `| Metric | Value |`,
            `|--------|-------|`,
            `| Gas Price | ${price.gasPriceGwei} Gwei |`,
            `| ETH Price (est.) | $${price.ethPriceUsd} |`,
            ``,
            `*Updated: ${new Date(price.timestamp).toLocaleTimeString()}*`,
          ];
          const doc = await vscode.workspace.openTextDocument({
            content: lines.join('\n'),
            language: 'markdown',
          });
          await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
        }
      );
    }),

    // 4byte lookup
    vscode.commands.registerCommand('sigscan.lookup4byte', async () => {
      const selector = await vscode.window.showInputBox({
        prompt: 'Enter a 4-byte selector (e.g. 0xa9059cbb)',
        placeHolder: '0x...',
      });
      if (!selector) {
        return;
      }
      const { FourByteLookup } = require('../features/four-byte-lookup');
      const fourByteLookup = new FourByteLookup();
      const results = await fourByteLookup.lookup(selector);
      if (results.length === 0) {
        vscode.window.showInformationMessage(`No matches found for ${selector}`);
      } else {
        const picked = await vscode.window.showQuickPick(results, {
          placeHolder: `${results.length} matches for ${selector}`,
        });
        if (picked) {
          await vscode.env.clipboard.writeText(picked);
          vscode.window.showInformationMessage(`Copied: ${picked}`);
        }
      }
    }),

    // Test generator
    vscode.commands.registerCommand('sigscan.generateTests', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.languageId !== 'solidity') {
        vscode.window.showErrorMessage('Open a Solidity file to generate tests');
        return;
      }
      const { SolidityParser } = await import('../core/parser');
      const parser = new SolidityParser();
      const contractInfo = parser.parseContent(
        editor.document.getText(),
        editor.document.uri.fsPath
      );
      if (!contractInfo) {
        vscode.window.showErrorMessage('Could not parse contract');
        return;
      }
      const { TestGenerator } = require('../features/test-generator');
      const testGenerator = new TestGenerator();
      const testContent = testGenerator.generateTestFile(contractInfo);
      const doc = await vscode.workspace.openTextDocument({
        content: testContent,
        language: 'solidity',
      });
      await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
    }),

    // Playground webview
    vscode.commands.registerCommand('sigscan.openPlayground', () => {
      const { PlaygroundPanel } = require('./providers/playground');
      PlaygroundPanel.createOrShow(context.extensionUri);
    }),

    // Dashboard webview
    vscode.commands.registerCommand('sigscan.openDashboard', () => {
      const { DashboardPanel } = require('./providers/dashboard');
      DashboardPanel.createOrShow(context.extensionUri);
    }),

    // Forge test runner
    vscode.commands.registerCommand(
      'sigscan.forgeRunTest',
      async (uri: vscode.Uri, testName: string) => {
        await getForgeTestProvider().runTest(uri, testName);
      }
    ),

    vscode.commands.registerCommand('sigscan.forgeRunAllTests', async (uri: vscode.Uri) => {
      await getForgeTestProvider().runAllTests(uri);
    }),

    // Security analysis reports
    vscode.commands.registerCommand('sigscan.detectReentrancy', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.languageId !== 'solidity') {
        vscode.window.showErrorMessage('Open a Solidity file to analyze');
        return;
      }
      const analyzers = getSecurityAnalyzers();
      const warnings = analyzers.reentrancy.detect(editor.document.getText());
      const report = analyzers.reentrancy.generateReport(warnings);
      const doc = await vscode.workspace.openTextDocument({
        content: report,
        language: 'markdown',
      });
      await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
    }),

    vscode.commands.registerCommand('sigscan.detectUncheckedCalls', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.languageId !== 'solidity') {
        vscode.window.showErrorMessage('Open a Solidity file to analyze');
        return;
      }
      const analyzers = getSecurityAnalyzers();
      const warnings = analyzers.uncheckedCalls.detect(editor.document.getText());
      const report = analyzers.uncheckedCalls.generateReport(warnings);
      const doc = await vscode.workspace.openTextDocument({
        content: report,
        language: 'markdown',
      });
      await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
    }),

    vscode.commands.registerCommand('sigscan.checkEvents', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.languageId !== 'solidity') {
        vscode.window.showErrorMessage('Open a Solidity file to analyze');
        return;
      }
      const analyzers = getSecurityAnalyzers();
      const warnings = analyzers.events.detect(editor.document.getText());
      const report = analyzers.events.generateReport(warnings);
      const doc = await vscode.workspace.openTextDocument({
        content: report,
        language: 'markdown',
      });
      await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
    }),

    vscode.commands.registerCommand('sigscan.checkAccessControl', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.languageId !== 'solidity') {
        vscode.window.showErrorMessage('Open a Solidity file to analyze');
        return;
      }
      const analyzers = getSecurityAnalyzers();
      const warnings = analyzers.accessControl.detect(editor.document.getText());
      const report = analyzers.accessControl.generateReport(warnings);
      const doc = await vscode.workspace.openTextDocument({
        content: report,
        language: 'markdown',
      });
      await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
    }),

    vscode.commands.registerCommand('sigscan.suggestCustomErrors', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.languageId !== 'solidity') {
        vscode.window.showErrorMessage('Open a Solidity file to analyze');
        return;
      }
      const analyzers = getSecurityAnalyzers();
      const suggestions = analyzers.customErrors.detect(editor.document.getText());
      const report = analyzers.customErrors.generateReport(suggestions);
      const doc = await vscode.workspace.openTextDocument({
        content: report,
        language: 'markdown',
      });
      await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
    }),

    vscode.commands.registerCommand('sigscan.checkNatspec', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.languageId !== 'solidity') {
        vscode.window.showErrorMessage('Open a Solidity file to analyze');
        return;
      }
      const analyzers = getSecurityAnalyzers();
      const warnings = analyzers.natspec.detect(editor.document.getText());
      const report = analyzers.natspec.generateReport(warnings);
      const doc = await vscode.workspace.openTextDocument({
        content: report,
        language: 'markdown',
      });
      await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
    }),

    vscode.commands.registerCommand('sigscan.detectDangerousPatterns', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.languageId !== 'solidity') {
        vscode.window.showErrorMessage('Open a Solidity file to analyze');
        return;
      }
      const analyzers = getSecurityAnalyzers();
      const warnings = analyzers.dangerousPatterns.detect(editor.document.getText());
      const report = analyzers.dangerousPatterns.generateReport(warnings);
      const doc = await vscode.workspace.openTextDocument({
        content: report,
        language: 'markdown',
      });
      await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
    }),

    vscode.commands.registerCommand('sigscan.detectDeFiRisks', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.languageId !== 'solidity') {
        vscode.window.showErrorMessage('Open a Solidity file to analyze');
        return;
      }
      const analyzers = getSecurityAnalyzers();
      const warnings = analyzers.defiRisks.detect(editor.document.getText());
      const report = analyzers.defiRisks.generateReport(warnings);
      const doc = await vscode.workspace.openTextDocument({
        content: report,
        language: 'markdown',
      });
      await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
    }),

    // Slither analysis
    vscode.commands.registerCommand('sigscan.runSlither', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.languageId !== 'solidity') {
        vscode.window.showErrorMessage('Open a Solidity file to analyze');
        return;
      }
      const { SlitherIntegration } = require('../features/slither-integration');
      const slither = new SlitherIntegration();

      if (!(await slither.isAvailable())) {
        vscode.window.showErrorMessage(
          'Slither not found. Install with: pip install slither-analyzer'
        );
        return;
      }

      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Running Slither analysis...' },
        async () => {
          const findings = await slither.analyze(editor.document.uri.fsPath);
          if (findings.length === 0) {
            vscode.window.showInformationMessage('Slither: No issues found!');
            return;
          }

          // Apply diagnostics
          const diags = slither.toDiagnostics(findings);
          const diagsByFile = new Map<string, vscode.Diagnostic[]>();
          for (const d of diags) {
            const fileKey = d.file || editor.document.uri.fsPath;
            const existing = diagsByFile.get(fileKey) || [];
            const severity =
              d.severity === 'error'
                ? vscode.DiagnosticSeverity.Error
                : d.severity === 'warning'
                  ? vscode.DiagnosticSeverity.Warning
                  : d.severity === 'info'
                    ? vscode.DiagnosticSeverity.Information
                    : vscode.DiagnosticSeverity.Hint;
            existing.push(
              new vscode.Diagnostic(
                new vscode.Range(Math.max(0, d.line - 1), 0, Math.max(0, d.line - 1), 999),
                d.message,
                severity
              )
            );
            diagsByFile.set(fileKey, existing);
          }

          const report = slither.generateReport(findings);
          const doc = await vscode.workspace.openTextDocument({
            content: report,
            language: 'markdown',
          });
          await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
        }
      );
    }),

    // Mythril analysis
    vscode.commands.registerCommand('sigscan.runMythril', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.languageId !== 'solidity') {
        vscode.window.showErrorMessage('Open a Solidity file to analyze');
        return;
      }
      const { MythrilIntegration } = require('../features/mythril-integration');
      const mythril = new MythrilIntegration();

      if (!(await mythril.isAvailable())) {
        vscode.window.showErrorMessage('Mythril not found. Install with: pip install mythril');
        return;
      }

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Running Mythril analysis (this may take a while)...',
          cancellable: true,
        },
        async () => {
          const issues = await mythril.analyze(editor.document.uri.fsPath);
          if (issues.length === 0) {
            vscode.window.showInformationMessage('Mythril: No issues found!');
            return;
          }

          const report = mythril.generateReport(issues);
          const doc = await vscode.workspace.openTextDocument({
            content: report,
            language: 'markdown',
          });
          await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
        }
      );
    }),

    // ─── On-Chain Features ────────────────────────────────────────────────

    // Transaction inspector
    vscode.commands.registerCommand('sigscan.inspectTransaction', async () => {
      const chains = [
        'ethereum',
        'sepolia',
        'polygon',
        'arbitrum',
        'optimism',
        'bsc',
        'base',
        'avalanche',
      ];
      const chain = await vscode.window.showQuickPick(chains, {
        placeHolder: 'Select chain',
        title: 'Which chain is this transaction on?',
      });
      if (!chain) {
        return;
      }
      const txHash = await vscode.window.showInputBox({
        prompt: 'Enter transaction hash',
        placeHolder: '0x...',
        validateInput: (v) =>
          /^0x[0-9a-fA-F]{64}$/.test(v) ? null : 'Invalid tx hash (must be 0x + 64 hex chars)',
      });
      if (!txHash) {
        return;
      }
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Fetching tx on ${chain}...` },
        async () => {
          const { TxInspector } = require('../features/tx-inspector');
          const rpc = getRpcProvider();
          const inspector = new TxInspector(rpc);
          const details = await inspector.inspect(txHash, chain);
          const report = inspector.generateReport(details);
          const doc = await vscode.workspace.openTextDocument({
            content: report,
            language: 'markdown',
          });
          await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
        }
      );
    }),

    // Address inspector
    vscode.commands.registerCommand('sigscan.exploreAddress', async () => {
      const chains = [
        'ethereum',
        'sepolia',
        'polygon',
        'arbitrum',
        'optimism',
        'bsc',
        'base',
        'avalanche',
      ];
      const chain = await vscode.window.showQuickPick(chains, { placeHolder: 'Select chain' });
      if (!chain) {
        return;
      }
      const address = await vscode.window.showInputBox({
        prompt: 'Enter address',
        placeHolder: '0x...',
        validateInput: (v) => (/^0x[0-9a-fA-F]{40}$/.test(v) ? null : 'Invalid address'),
      });
      if (!address) {
        return;
      }
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Inspecting address on ${chain}...`,
        },
        async () => {
          const { AddressInspector } = require('../features/address-inspector');
          const rpc = getRpcProvider();
          const inspector = new AddressInspector(rpc);
          const info = await inspector.inspect(address, chain);
          const report = inspector.generateReport(info);
          const doc = await vscode.workspace.openTextDocument({
            content: report,
            language: 'markdown',
          });
          await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
        }
      );
    }),

    // View contract events
    vscode.commands.registerCommand('sigscan.viewEvents', async () => {
      const chains = [
        'ethereum',
        'sepolia',
        'polygon',
        'arbitrum',
        'optimism',
        'bsc',
        'base',
        'avalanche',
      ];
      const chain = await vscode.window.showQuickPick(chains, { placeHolder: 'Select chain' });
      if (!chain) {
        return;
      }
      const address = await vscode.window.showInputBox({
        prompt: 'Enter contract address to fetch events from',
        placeHolder: '0x...',
        validateInput: (v) => (/^0x[0-9a-fA-F]{40}$/.test(v) ? null : 'Invalid address'),
      });
      if (!address) {
        return;
      }
      const blockRange = await vscode.window.showInputBox({
        prompt: 'How many recent blocks to scan? (max 1000)',
        value: '100',
      });
      if (!blockRange) {
        return;
      }
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Fetching events on ${chain}...` },
        async () => {
          const { EventDecoder } = require('../features/event-decoder');
          const rpc = getRpcProvider();
          const decoder = new EventDecoder(rpc);
          const currentBlock = await rpc.getBlockNumber(chain);
          const fromBlock = Math.max(0, currentBlock - parseInt(blockRange, 10));
          const events = await decoder.getEvents({
            chain,
            address,
            fromBlock,
            toBlock: currentBlock,
            maxBlocks: 1000,
          });
          const report = decoder.generateReport(events, {
            chain,
            address,
            fromBlock,
            toBlock: currentBlock,
          });
          const doc = await vscode.workspace.openTextDocument({
            content: report,
            language: 'markdown',
          });
          await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
        }
      );
    }),

    // Read contract state
    vscode.commands.registerCommand('sigscan.readContractState', async () => {
      const chains = [
        'ethereum',
        'sepolia',
        'polygon',
        'arbitrum',
        'optimism',
        'bsc',
        'base',
        'avalanche',
      ];
      const chain = await vscode.window.showQuickPick(chains, { placeHolder: 'Select chain' });
      if (!chain) {
        return;
      }
      const address = await vscode.window.showInputBox({
        prompt: 'Enter contract address',
        placeHolder: '0x...',
        validateInput: (v) => (/^0x[0-9a-fA-F]{40}$/.test(v) ? null : 'Invalid address'),
      });
      if (!address) {
        return;
      }
      const funcSig = await vscode.window.showInputBox({
        prompt: 'Enter function signature to call (e.g., "totalSupply()" or "balanceOf(address)")',
        placeHolder: 'totalSupply()',
      });
      if (!funcSig) {
        return;
      }
      let args: string[] = [];
      if (funcSig.includes('(') && !funcSig.endsWith('()')) {
        const argStr = await vscode.window.showInputBox({
          prompt: 'Enter arguments (comma-separated)',
          placeHolder: '0x1234..., 100',
        });
        if (argStr) {
          args = argStr.split(',').map((a) => a.trim());
        }
      }
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Reading contract state...' },
        async () => {
          const { ChainExplorer } = require('../features/chain-explorer');
          const rpc = getRpcProvider();
          const explorer = new ChainExplorer(rpc);
          const calldata = explorer.encodeCall(funcSig, args);
          const result = await explorer.simulateCall(chain, { to: address, data: calldata });
          const lines = [
            `# Contract State Read\n`,
            `**Chain:** ${chain}`,
            `**Contract:** \`${address}\``,
            `**Function:** \`${funcSig}\``,
            args.length > 0 ? `**Args:** ${args.map((a) => `\`${a}\``).join(', ')}\n` : '',
            `## Result\n`,
            result.success ? `**Status:** Success` : `**Status:** Reverted`,
            `**Raw data:** \`${result.data}\``,
          ];
          if (result.decoded && result.decoded.length > 0) {
            lines.push('\n| Type | Value |', '|------|-------|');
            for (const d of result.decoded) {
              lines.push(`| ${d.type} | \`${d.value}\` |`);
            }
          }
          const doc = await vscode.workspace.openTextDocument({
            content: lines.join('\n'),
            language: 'markdown',
          });
          await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
        }
      );
    }),

    // ERC20 token balance
    vscode.commands.registerCommand('sigscan.getTokenBalance', async () => {
      const chains = [
        'ethereum',
        'sepolia',
        'polygon',
        'arbitrum',
        'optimism',
        'bsc',
        'base',
        'avalanche',
      ];
      const chain = await vscode.window.showQuickPick(chains, { placeHolder: 'Select chain' });
      if (!chain) {
        return;
      }
      const tokenAddress = await vscode.window.showInputBox({
        prompt: 'Enter ERC20 token contract address',
        placeHolder: '0x...',
      });
      if (!tokenAddress) {
        return;
      }
      const holderAddress = await vscode.window.showInputBox({
        prompt: 'Enter holder address',
        placeHolder: '0x...',
      });
      if (!holderAddress) {
        return;
      }
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Fetching token balance...' },
        async () => {
          const { ChainExplorer } = require('../features/chain-explorer');
          const rpc = getRpcProvider();
          const explorer = new ChainExplorer(rpc);
          const balance = await explorer.getTokenBalance(chain, tokenAddress, holderAddress);
          vscode.window.showInformationMessage(
            `${balance.symbol} Balance: ${balance.formatted} (${balance.raw} raw, ${balance.decimals} decimals)`
          );
        }
      );
    }),

    // ─── Foundry Tools ────────────────────────────────────────────────────

    // Cast command
    vscode.commands.registerCommand('sigscan.castCommand', async () => {
      const { CastIntegration } = require('../features/cast-integration');
      const cast = new CastIntegration();
      if (!(await cast.isAvailable())) {
        vscode.window.showErrorMessage(
          'Cast not found. Install Foundry: curl -L https://foundry.paradigm.xyz | bash'
        );
        return;
      }
      const commands = [
        'call — Simulate contract call',
        'balance — Get ETH balance',
        'code — Get contract bytecode',
        'storage — Read storage slot',
        'sig — Get function selector',
        'keccak — Hash data',
        'abi-encode — Encode function args',
        'abi-decode — Decode ABI data',
        'calldata — Encode calldata',
        'to-wei — Convert to wei',
        'from-wei — Convert from wei',
        'to-hex — Convert to hex',
        'to-dec — Convert to decimal',
        'to-checksum — Checksum address',
        'gas-price — Get gas price',
        'block — Get block info',
        'interface — Generate interface from ABI',
        'raw — Run any cast command',
      ];
      const picked = await vscode.window.showQuickPick(commands, {
        placeHolder: 'Select cast command',
      });
      if (!picked) {
        return;
      }
      const cmd = picked.split(' — ')[0];
      const args = await vscode.window.showInputBox({
        prompt: `Enter arguments for "cast ${cmd}"`,
        placeHolder: cmd === 'raw' ? 'e.g.: block latest --rpc-url https://eth.llamarpc.com' : '',
      });
      if (args === undefined) {
        return;
      }
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Running cast ${cmd}...` },
        async () => {
          const result =
            cmd === 'raw'
              ? await cast.raw(args.split(/\s+/))
              : await cast.raw([cmd, ...args.split(/\s+/).filter(Boolean)]);
          if (result.success) {
            const doc = await vscode.workspace.openTextDocument({
              content: `# cast ${cmd}\n\n\`\`\`\n${result.output}\n\`\`\``,
              language: 'markdown',
            });
            await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
          } else {
            vscode.window.showErrorMessage(`cast ${cmd} failed: ${result.error}`);
          }
        }
      );
    }),

    // Start Anvil
    vscode.commands.registerCommand('sigscan.startAnvil', async () => {
      const { AnvilManager } = require('../features/anvil-manager');
      if (!_anvilManager) {
        _anvilManager = new AnvilManager();
      }
      const anvil = _anvilManager!;
      if (!(await anvil.isAvailable())) {
        vscode.window.showErrorMessage(
          'Anvil not found. Install Foundry: curl -L https://foundry.paradigm.xyz | bash'
        );
        return;
      }
      if (anvil.isRunning()) {
        vscode.window.showWarningMessage(`Anvil already running at ${anvil.getRpcUrl()}`);
        return;
      }
      const forkChoice = await vscode.window.showQuickPick(
        [
          'No fork (blank state)',
          'Fork Ethereum Mainnet',
          'Fork Sepolia',
          'Fork Polygon',
          'Fork Arbitrum',
          'Fork Base',
          'Custom RPC URL',
        ],
        { placeHolder: 'Start Anvil with fork?' }
      );
      if (!forkChoice) {
        return;
      }
      const forkUrls: Record<string, string> = {
        'Fork Ethereum Mainnet': 'https://eth.llamarpc.com',
        'Fork Sepolia': 'https://rpc.sepolia.org',
        'Fork Polygon': 'https://polygon-rpc.com',
        'Fork Arbitrum': 'https://arb1.arbitrum.io/rpc',
        'Fork Base': 'https://mainnet.base.org',
      };
      let forkUrl: string | undefined;
      if (forkChoice === 'Custom RPC URL') {
        forkUrl = await vscode.window.showInputBox({ prompt: 'Enter RPC URL to fork from' });
        if (!forkUrl) {
          return;
        }
      } else if (forkChoice !== 'No fork (blank state)') {
        forkUrl = forkUrls[forkChoice];
      }
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Starting Anvil...' },
        async () => {
          const state = await anvil.start({ forkUrl });
          vscode.window.showInformationMessage(
            `Anvil running at ${state.rpcUrl} (${state.accounts.length} accounts funded)`
          );
        }
      );
    }),

    // Stop Anvil
    vscode.commands.registerCommand('sigscan.stopAnvil', async () => {
      if (!_anvilManager || !_anvilManager.isRunning()) {
        vscode.window.showWarningMessage('Anvil is not running');
        return;
      }
      await _anvilManager.stop();
      vscode.window.showInformationMessage('Anvil stopped');
    }),

    // Forge script runner
    vscode.commands.registerCommand('sigscan.runForgeScript', async () => {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) {
        vscode.window.showErrorMessage('No workspace folder open');
        return;
      }
      const { ForgeScriptRunner } = require('../features/forge-script-runner');
      const runner = new ForgeScriptRunner();
      if (!(await runner.isAvailable())) {
        vscode.window.showErrorMessage('Forge not found. Install Foundry.');
        return;
      }
      const scripts = await runner.discoverScripts(workspaceFolder.uri.fsPath);
      if (scripts.length === 0) {
        vscode.window.showWarningMessage('No .s.sol scripts found in script/ directory');
        return;
      }
      const scriptPath = await vscode.window.showQuickPick(scripts, {
        placeHolder: 'Select script to run',
      });
      if (!scriptPath) {
        return;
      }
      const mode = await vscode.window.showQuickPick(
        ['Dry run (simulate)', 'Broadcast (send transactions)'],
        { placeHolder: 'Run mode' }
      );
      if (!mode) {
        return;
      }
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Running ${path.basename(scriptPath)}...`,
        },
        async () => {
          const scriptConfig: any = { scriptPath, broadcast: mode.startsWith('Broadcast') };
          if (scriptConfig.broadcast) {
            const rpcUrl = await vscode.window.showInputBox({
              prompt: 'RPC URL',
              value: 'http://localhost:8545',
            });
            if (!rpcUrl) {
              return;
            }
            scriptConfig.rpcUrl = rpcUrl;
          }
          const result = await runner.run(scriptConfig);
          const report = runner.generateReport(result, scriptConfig);
          const doc = await vscode.workspace.openTextDocument({
            content: report,
            language: 'markdown',
          });
          await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
        }
      );
    }),

    // Flatten contract
    vscode.commands.registerCommand('sigscan.flattenContract', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.languageId !== 'solidity') {
        vscode.window.showErrorMessage('Open a Solidity file to flatten');
        return;
      }
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Flattening contract...' },
        async () => {
          const { ContractFlattener } = require('../features/contract-flattener');
          const flattener = new ContractFlattener();
          const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
          const result = await flattener.flatten(editor.document.uri.fsPath, workspaceRoot);
          if (result.success) {
            const doc = await vscode.workspace.openTextDocument({
              content: result.output,
              language: 'solidity',
            });
            await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
            vscode.window.showInformationMessage(
              `Flattened ${result.sourceFiles.length} files (${result.totalLines} lines)`
            );
          } else {
            vscode.window.showErrorMessage(`Flatten failed: ${result.error}`);
          }
        }
      );
    }),

    // ─── Snippets ─────────────────────────────────────────────────────────

    vscode.commands.registerCommand('sigscan.insertSnippet', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showErrorMessage('No active editor');
        return;
      }
      const { SnippetProvider } = require('../features/snippet-provider');
      const snippetProvider = new SnippetProvider();
      const categories = snippetProvider.getCategories();
      const category = await vscode.window.showQuickPick(categories, {
        placeHolder: 'Select snippet category',
      });
      if (!category) {
        return;
      }
      const snippets = snippetProvider.getByCategory(category);
      const items = snippets.map((s: any) => ({
        label: s.prefix,
        description: s.label,
        detail: s.description,
        _body: s.body,
      }));
      const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Select snippet' });
      if (!picked) {
        return;
      }
      const snippet = new vscode.SnippetString((picked as any)._body);
      editor.insertSnippet(snippet);
    }),

    // ─── Advanced: Tenderly, Fork Sim, Hardhat ────────────────────────────

    // Tenderly trace
    vscode.commands.registerCommand('sigscan.traceTenderly', async () => {
      const chains = [
        'ethereum',
        'sepolia',
        'polygon',
        'arbitrum',
        'optimism',
        'bsc',
        'base',
        'avalanche',
      ];
      const chain = await vscode.window.showQuickPick(chains, { placeHolder: 'Select chain' });
      if (!chain) {
        return;
      }
      const txHash = await vscode.window.showInputBox({
        prompt: 'Enter transaction hash to trace',
        placeHolder: '0x...',
        validateInput: (v) => (/^0x[0-9a-fA-F]{64}$/.test(v) ? null : 'Invalid tx hash'),
      });
      if (!txHash) {
        return;
      }
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Tracing transaction via Tenderly...',
        },
        async () => {
          const config = vscode.workspace.getConfiguration('sigscan');
          const { TenderlyIntegration } = require('../features/tenderly-integration');
          const tenderly = new TenderlyIntegration({
            accessKey: config.get('tenderly.accessKey', ''),
            accountSlug: config.get('tenderly.accountSlug', ''),
            projectSlug: config.get('tenderly.projectSlug', ''),
          });
          const trace = await tenderly.traceTransaction(txHash, chain);
          if (!trace) {
            vscode.window.showWarningMessage(
              'Could not fetch trace. Check Tenderly configuration.'
            );
            return;
          }
          const report = tenderly.generateReport(trace);
          const doc = await vscode.workspace.openTextDocument({
            content: report,
            language: 'markdown',
          });
          await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
        }
      );
    }),

    // Fork simulator
    vscode.commands.registerCommand('sigscan.simulateFork', async () => {
      const { ForkSimulator } = require('../features/fork-simulator');
      if (!_forkSimulator) {
        _forkSimulator = new ForkSimulator();
      }
      const forkSim = _forkSimulator!;
      if (!(await forkSim.isAvailable())) {
        vscode.window.showErrorMessage('Anvil not found. Install Foundry for fork simulation.');
        return;
      }
      if (forkSim.isRunning()) {
        vscode.window.showInformationMessage(
          'Fork already running. Use readContractState/castCommand to interact.'
        );
        return;
      }
      const chains = [
        'ethereum',
        'sepolia',
        'polygon',
        'arbitrum',
        'optimism',
        'bsc',
        'base',
        'avalanche',
      ];
      const chain = await vscode.window.showQuickPick(chains, {
        placeHolder: 'Select chain to fork',
      });
      if (!chain) {
        return;
      }
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Starting ${chain} fork...` },
        async () => {
          const result = await forkSim.startFork({ chain, port: 8546 });
          vscode.window.showInformationMessage(
            `Fork running at ${result.rpcUrl} (block ${result.forkBlock}, ${result.accounts.length} accounts)`
          );
        }
      );
    }),

    // Stop fork
    vscode.commands.registerCommand('sigscan.stopFork', async () => {
      if (!_forkSimulator || !_forkSimulator.isRunning()) {
        vscode.window.showWarningMessage('No fork running');
        return;
      }
      await _forkSimulator.stopFork();
      vscode.window.showInformationMessage('Fork stopped');
    }),

    // Hardhat task
    vscode.commands.registerCommand('sigscan.runHardhatTask', async () => {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) {
        vscode.window.showErrorMessage('No workspace folder open');
        return;
      }
      const { HardhatIntegration } = require('../features/hardhat-integration');
      const hardhat = new HardhatIntegration();
      if (!(await hardhat.isHardhatProject(workspaceFolder.uri.fsPath))) {
        vscode.window.showWarningMessage('Not a Hardhat project (no hardhat.config found)');
        return;
      }
      const tasks = await hardhat.listTasks(workspaceFolder.uri.fsPath);
      const task = await vscode.window.showQuickPick(
        tasks.length > 0 ? tasks : ['compile', 'test', 'clean', 'node'],
        {
          placeHolder: 'Select Hardhat task',
        }
      );
      if (!task) {
        return;
      }
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Running hardhat ${task}...` },
        async () => {
          const result = await hardhat.runTask(workspaceFolder.uri.fsPath, task);
          const report = hardhat.generateReport(result, task);
          const doc = await vscode.workspace.openTextDocument({
            content: report,
            language: 'markdown',
          });
          await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
        }
      );
    }),

    // Hardhat compile shortcut
    vscode.commands.registerCommand('sigscan.hardhatCompile', async () => {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) {
        return;
      }
      const { HardhatIntegration } = require('../features/hardhat-integration');
      const hardhat = new HardhatIntegration();
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Hardhat compiling...' },
        async () => {
          const result = await hardhat.compile(workspaceFolder.uri.fsPath);
          if (result.success) {
            vscode.window.showInformationMessage('Hardhat compilation successful');
          } else {
            vscode.window.showErrorMessage(
              `Hardhat compilation failed: ${result.error || result.output}`
            );
          }
        }
      );
    }),

    // Hardhat test shortcut
    vscode.commands.registerCommand('sigscan.hardhatTest', async () => {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) {
        return;
      }
      const { HardhatIntegration } = require('../features/hardhat-integration');
      const hardhat = new HardhatIntegration();
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Hardhat running tests...' },
        async () => {
          const result = await hardhat.test(workspaceFolder.uri.fsPath);
          const report = hardhat.generateReport(result, 'test');
          const doc = await vscode.workspace.openTextDocument({
            content: report,
            language: 'markdown',
          });
          await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
        }
      );
    }),
  ];

  // Register selector hover provider
  const selectorHover = vscode.languages.registerHoverProvider(
    { scheme: 'file', pattern: '**/*' },
    selectorHoverProvider
  );

  // Register snippet completion provider (lazy-loaded singleton)
  let _snippetProviderInstance: any = null;
  function getSnippetProvider() {
    if (!_snippetProviderInstance) {
      const { SnippetProvider: SP } = require('../features/snippet-provider');
      _snippetProviderInstance = new SP();
    }
    return _snippetProviderInstance;
  }
  const snippetCompletion = vscode.languages.registerCompletionItemProvider(
    { scheme: 'file', language: 'solidity' },
    {
      provideCompletionItems(document, position) {
        const linePrefix = document.lineAt(position).text.substring(0, position.character);
        // Only trigger on empty lines or after whitespace
        if (linePrefix.trim().length > 20) {
          return undefined;
        }
        const sp = getSnippetProvider();
        const query = linePrefix.trim().toLowerCase();
        const matches = query.length > 0 ? sp.search(query) : [];
        return matches.map((s: any) => {
          const item = new vscode.CompletionItem(s.prefix, vscode.CompletionItemKind.Snippet);
          item.insertText = new vscode.SnippetString(s.body);
          item.documentation = new vscode.MarkdownString(s.description);
          item.detail = `[0xTools] ${s.label}`;
          item.sortText = `0_${s.prefix}`;
          return item;
        });
      },
    },
    ...'abcdefghijklmnopqrstuvwxyz'.split('')
  );

  // Register notebook serializer (lazy-loaded)
  const { SigScanNotebookSerializer, SigScanNotebookController } =
    require('./providers/notebook-provider') as NotebookProviderModule;
  const notebookSerializer = vscode.workspace.registerNotebookSerializer(
    SigScanNotebookController.notebookType,
    new SigScanNotebookSerializer()
  );
  const notebookController = new SigScanNotebookController();

  // Register combined hover provider (uses cached analysis to prevent flickering)
  const hoverProvider = vscode.languages.registerHoverProvider(
    { scheme: 'file', language: 'solidity' },
    {
      provideHover(document, position) {
        // First try cached realtime analysis (doesn't trigger new analysis)
        const cachedAnalysis = realtimeAnalyzer.getCachedAnalysis(document);
        if (cachedAnalysis) {
          const realtimeHover = realtimeAnalyzer.createHoverInfo(
            position,
            cachedAnalysis,
            document
          );
          if (realtimeHover) {
            return realtimeHover;
          }
        }
        // Fall back to signature manager hover
        return sigScanManager.provideHover(document, position);
      },
    }
  );

  // Content hash guard: skip re-compilation if content hasn't changed
  const lastCompiledHash = new Map<string, string>();
  function simpleHash(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash |= 0; // Convert to 32bit integer
    }
    return hash.toString(36);
  }

  // Helper function to update decorations with colored gas hints
  // Uses Remix-style compilation with AST-based gas mapping
  let lastDisabledLogTime = 0;
  async function updateDecorations(editor: vscode.TextEditor, isFileOpenEvent = false) {
    const config = vscode.workspace.getConfiguration('sigscan');
    if (!config.get('realtimeAnalysis', true)) {
      // Only log once per 5 seconds to avoid spam
      const now = Date.now();
      if (now - lastDisabledLogTime > 5000) {
        logger.debug(
          'Realtime analysis disabled in settings - enable with "0xTools: Toggle Real-time Gas Analysis"'
        );
        lastDisabledLogTime = now;
      }
      return;
    }

    if (editor.document.languageId === 'solidity') {
      const uri = editor.document.uri.toString();
      const source = editor.document.getText();
      const fileName = path.basename(editor.document.uri.fsPath);

      // Skip re-compilation if content hasn't changed
      const contentHash = simpleHash(source);
      if (lastCompiledHash.get(uri) === contentHash) {
        logger.debug(`Skipping compilation for ${fileName} — content unchanged`);
        return;
      }
      lastCompiledHash.set(uri, contentHash);

      logger.info(`Compiling ${fileName}...`);

      // Use Remix-style compilation service directly
      const trigger = isFileOpenEvent ? 'file-open' : 'manual';

      try {
        const result = await compilationService.compile(uri, source, trigger, (importPath) => {
          // Import resolver - tries remappings first, then common paths
          const fileDir = path.dirname(editor.document.uri.fsPath);

          // Find project root (look for foundry.toml or hardhat.config.js)
          let projectRoot = fileDir;
          let current = fileDir;
          while (current !== path.dirname(current)) {
            if (
              fs.existsSync(path.join(current, 'foundry.toml')) ||
              fs.existsSync(path.join(current, 'hardhat.config.js')) ||
              fs.existsSync(path.join(current, 'hardhat.config.ts'))
            ) {
              projectRoot = current;
              break;
            }
            current = path.dirname(current);
          }

          // Reload remappings if project root changed
          const resolver = getRemappingsResolver();
          if (resolver.getRemappings().length === 0 || projectRoot !== workspaceRoot) {
            resolver.load(projectRoot);
          }

          // 0. Try remappings first (handles @openzeppelin/, forge-std/, etc.)
          const remapped = resolver.resolve(importPath);
          if (remapped) {
            logger.debug(`Resolved import via remapping: ${importPath} -> ${remapped}`);
            return { contents: fs.readFileSync(remapped, 'utf-8') };
          }

          // Paths to try in order
          const pathsToTry = [
            // 1. Relative to file's directory (handles "../lib/X.sol")
            path.resolve(fileDir, importPath),
            // 2. From project root (handles "lib/X.sol")
            path.resolve(projectRoot, importPath),
            // 3. Foundry lib folder (handles "openzeppelin/X.sol")
            path.resolve(projectRoot, 'lib', importPath),
            // 4. Hardhat node_modules
            path.resolve(projectRoot, 'node_modules', importPath),
            // 5. node_modules relative to file
            path.resolve(fileDir, 'node_modules', importPath),
          ];

          for (const fullPath of pathsToTry) {
            if (fs.existsSync(fullPath)) {
              logger.debug(`Resolved import: ${importPath}`);
              return { contents: fs.readFileSync(fullPath, 'utf-8') };
            }
          }

          logger.warn(`Import not found: ${importPath}`);
          return { error: `Import not found: ${importPath}` };
        });

        if (result.gasInfo.length > 0) {
          // Use Remix-style decorations with AST-based source locations
          // This works for both successful compilation AND fallback regex extraction
          const decorations = realtimeAnalyzer.createRemixStyleDecorations(
            result.gasInfo,
            editor.document
          );
          editor.setDecorations(gasDecorationType, decorations);

          if (result.success) {
            logger.info(`Applied ${decorations.length} gas decorations (solc ${result.version})`);
          } else {
            logger.warn(
              `Applied ${decorations.length} selector-only decorations (compilation failed, using fallback)`
            );
          }

          // Log all gas info
          for (const info of result.gasInfo) {
            const gasStr =
              info.gas === 'infinite' ? '∞' : info.gas === 0 ? 'N/A' : info.gas.toLocaleString();
            logger.debug(`${info.name}() @ line ${info.loc.line}: ${gasStr} gas`);
          }
        }

        // Check contract size against 24KB EIP-170 limit
        if (result.deployedBytecodeSize) {
          const bytecodeBytes = result.deployedBytecodeSize;
          const sizeKB = bytecodeBytes / 1024;
          const EIP170_LIMIT = 24576; // 24KB
          const WARNING_THRESHOLD = EIP170_LIMIT * 0.9; // 90%

          if (bytecodeBytes > EIP170_LIMIT) {
            vscode.window
              .showWarningMessage(
                `${fileName} exceeds 24KB deployment limit! (${sizeKB.toFixed(1)}KB) — contract cannot be deployed. Consider splitting into libraries or using the diamond pattern.`,
                'Show Details'
              )
              .then((choice) => {
                if (choice === 'Show Details') {
                  vscode.commands.executeCommand('sigscan.checkContractSize');
                }
              });
            // Add diagnostic
            const firstLine = editor.document.lineAt(0).range;
            const sizeDiag = new vscode.Diagnostic(
              firstLine,
              `Contract bytecode is ${sizeKB.toFixed(1)}KB — exceeds 24KB EIP-170 deployment limit`,
              vscode.DiagnosticSeverity.Error
            );
            sizeDiag.source = '0xTools';
            sizeDiag.code = 'eip170-size';
            const existingDiags = diagnosticCollection.get(editor.document.uri);
            if (existingDiags) {
              const updated = [...existingDiags, sizeDiag];
              diagnosticCollection.set(editor.document.uri, updated);
            } else {
              diagnosticCollection.set(editor.document.uri, [sizeDiag]);
            }
          } else if (bytecodeBytes > WARNING_THRESHOLD) {
            const pct = ((bytecodeBytes / EIP170_LIMIT) * 100).toFixed(0);
            vscode.window.showWarningMessage(
              `${fileName} is ${sizeKB.toFixed(1)}KB (${pct}% of 24KB limit). Approaching deployment size limit.`
            );
          }
        }

        if (!result.success && result.gasInfo.length === 0) {
          logger.error(`Compilation failed and no functions extracted: ${result.errors[0]}`);
        } else if (result.gasInfo.length === 0) {
          logger.warn('Compilation succeeded but no gas info extracted');
        }

        // Security analysis is handled separately by runSecurityAnalysis()
        // which only fires on file save/open events (not on every keystroke)
      } catch (error) {
        logger.error(`Decoration update error: ${error}`);
      }
    }
  }

  // Gas annotations now use colored decorations (gradient from green to red)

  // Legacy analysisReady listener disabled — it races with the primary
  // runner/forge/solc pipeline and overwrites richer decorations with sparser ones.
  // The primary pipeline (updateDecorations -> compilationService.compile ->
  // createRemixStyleDecorations) handles all decoration updates.

  // ─── Security analyzers — lazy loaded on first save ──────────────────────
  let _securityAnalyzers: {
    reentrancy: InstanceType<typeof import('../features/reentrancy-detector').ReentrancyDetector>;
    uncheckedCalls: InstanceType<
      typeof import('../features/unchecked-calls').UncheckedCallDetector
    >;
    events: InstanceType<typeof import('../features/event-checker').EventEmissionChecker>;
    accessControl: InstanceType<typeof import('../features/access-control').AccessControlAnalyzer>;
    customErrors: InstanceType<
      typeof import('../features/custom-error-suggestions').CustomErrorDetector
    >;
    natspec: InstanceType<typeof import('../features/natspec-checker').NatspecChecker>;
    dangerousPatterns: InstanceType<
      typeof import('../features/dangerous-patterns').DangerousPatternDetector
    >;
    defiRisks: InstanceType<typeof import('../features/defi-risks').DeFiRiskDetector>;
  } | null = null;

  function getSecurityAnalyzers() {
    if (!_securityAnalyzers) {
      const { ReentrancyDetector } = require('../features/reentrancy-detector');
      const { UncheckedCallDetector } = require('../features/unchecked-calls');
      const { EventEmissionChecker } = require('../features/event-checker');
      const { AccessControlAnalyzer } = require('../features/access-control');
      const { CustomErrorDetector } = require('../features/custom-error-suggestions');
      const { NatspecChecker } = require('../features/natspec-checker');
      const { DangerousPatternDetector } = require('../features/dangerous-patterns');
      const { DeFiRiskDetector } = require('../features/defi-risks');
      _securityAnalyzers = {
        reentrancy: new ReentrancyDetector(),
        uncheckedCalls: new UncheckedCallDetector(),
        events: new EventEmissionChecker(),
        accessControl: new AccessControlAnalyzer(),
        customErrors: new CustomErrorDetector(),
        natspec: new NatspecChecker(),
        dangerousPatterns: new DangerousPatternDetector(),
        defiRisks: new DeFiRiskDetector(),
      };
    }
    return _securityAnalyzers;
  }

  // ─── Security analysis (only on save/open, 2s debounce) ──────────────────
  let securityAnalysisTimer: NodeJS.Timeout | undefined;
  const lastSecurityHash = new Map<string, string>();

  function runSecurityAnalysis(editor: vscode.TextEditor) {
    if (securityAnalysisTimer) {
      clearTimeout(securityAnalysisTimer);
    }
    securityAnalysisTimer = setTimeout(() => {
      runSecurityAnalysisImmediate(editor);
    }, 2000); // 2-second debounce
  }

  function runSecurityAnalysisImmediate(editor: vscode.TextEditor) {
    if (editor.document.languageId !== 'solidity') {
      return;
    }
    const source = editor.document.getText();
    const uri = editor.document.uri.toString();

    // Skip if content hasn't changed since last security analysis
    const contentHash = simpleHash(source);
    if (lastSecurityHash.get(uri) === contentHash) {
      return;
    }
    lastSecurityHash.set(uri, contentHash);

    const analyzers = getSecurityAnalyzers();
    const securityDiags: vscode.Diagnostic[] = [];

    // Reentrancy detection
    const reentrancyWarnings = analyzers.reentrancy.detect(source);
    for (const w of reentrancyWarnings) {
      const line = Math.max(0, w.line - 1);
      if (line < editor.document.lineCount) {
        const diag = new vscode.Diagnostic(
          editor.document.lineAt(line).range,
          `${w.functionName}(): ${w.description}`,
          w.severity === 'high'
            ? vscode.DiagnosticSeverity.Warning
            : vscode.DiagnosticSeverity.Information
        );
        diag.source = '0xTools';
        diag.code = 'reentrancy';
        securityDiags.push(diag);
      }
    }

    // Unchecked calls
    const uncheckedWarnings = analyzers.uncheckedCalls.detect(source);
    for (const w of uncheckedWarnings) {
      const line = Math.max(0, w.line - 1);
      if (line < editor.document.lineCount) {
        const diag = new vscode.Diagnostic(
          editor.document.lineAt(line).range,
          `${w.functionName}(): ${w.description}`,
          vscode.DiagnosticSeverity.Warning
        );
        diag.source = '0xTools';
        diag.code = 'unchecked-call';
        securityDiags.push(diag);
      }
    }

    // Missing events
    const eventWarnings = analyzers.events.detect(source);
    for (const w of eventWarnings) {
      const line = Math.max(0, w.line - 1);
      if (line < editor.document.lineCount) {
        const diag = new vscode.Diagnostic(
          editor.document.lineAt(line).range,
          `${w.functionName}(): ${w.description}`,
          vscode.DiagnosticSeverity.Hint
        );
        diag.source = '0xTools';
        diag.code = 'missing-event';
        securityDiags.push(diag);
      }
    }

    // Access control
    const accessWarnings = analyzers.accessControl.detect(source);
    for (const w of accessWarnings) {
      const line = Math.max(0, w.line - 1);
      if (line < editor.document.lineCount) {
        const diag = new vscode.Diagnostic(
          editor.document.lineAt(line).range,
          `${w.description}`,
          w.severity === 'high'
            ? vscode.DiagnosticSeverity.Warning
            : vscode.DiagnosticSeverity.Information
        );
        diag.source = '0xTools';
        diag.code = 'access-control';
        securityDiags.push(diag);
      }
    }

    // Custom error suggestions
    const errorSuggestions = analyzers.customErrors.detect(source);
    for (const s of errorSuggestions) {
      const line = Math.max(0, s.line - 1);
      if (line < editor.document.lineCount) {
        const diag = new vscode.Diagnostic(
          editor.document.lineAt(line).range,
          `${s.description}`,
          vscode.DiagnosticSeverity.Hint
        );
        diag.source = '0xTools';
        diag.code = 'custom-error';
        securityDiags.push(diag);
      }
    }

    // NatSpec completeness
    const natspecWarnings = analyzers.natspec.detect(source);
    for (const w of natspecWarnings) {
      const line = Math.max(0, w.line - 1);
      if (line < editor.document.lineCount) {
        const diag = new vscode.Diagnostic(
          editor.document.lineAt(line).range,
          `${w.functionName}(): ${w.description}`,
          vscode.DiagnosticSeverity.Hint
        );
        diag.source = '0xTools';
        diag.code = 'natspec';
        securityDiags.push(diag);
      }
    }

    // Dangerous patterns (tx.origin, selfdestruct, delegatecall, proxy, decimals)
    const dangerousWarnings = analyzers.dangerousPatterns.detect(source);
    for (const w of dangerousWarnings) {
      const line = Math.max(0, w.line - 1);
      if (line < editor.document.lineCount) {
        const diagSeverity =
          w.severity === 'critical'
            ? vscode.DiagnosticSeverity.Error
            : w.severity === 'high'
              ? vscode.DiagnosticSeverity.Warning
              : vscode.DiagnosticSeverity.Information;
        const diag = new vscode.Diagnostic(
          editor.document.lineAt(line).range,
          `${w.functionName}(): ${w.description}`,
          diagSeverity
        );
        diag.source = '0xTools';
        diag.code = w.patternType;
        securityDiags.push(diag);
      }
    }

    // DeFi risks (stale oracle, precision loss, infinite approval, zero-address, vault inflation)
    const defiWarnings = analyzers.defiRisks.detect(source);
    for (const w of defiWarnings) {
      const line = Math.max(0, w.line - 1);
      if (line < editor.document.lineCount) {
        const diagSeverity =
          w.severity === 'high'
            ? vscode.DiagnosticSeverity.Warning
            : w.severity === 'medium'
              ? vscode.DiagnosticSeverity.Information
              : vscode.DiagnosticSeverity.Hint;
        const diag = new vscode.Diagnostic(
          editor.document.lineAt(line).range,
          `${w.functionName}(): ${w.description}`,
          diagSeverity
        );
        diag.source = '0xTools';
        diag.code = w.riskType;
        securityDiags.push(diag);
      }
    }

    // Merge with existing diagnostics (keep EIP-170 size diagnostics if present)
    const existingDiags = diagnosticCollection.get(editor.document.uri);
    const eip170Diags = existingDiags
      ? [...existingDiags].filter((d) => d.code === 'eip170-size')
      : [];
    diagnosticCollection.set(editor.document.uri, [...eip170Diags, ...securityDiags]);

    if (securityDiags.length > 0) {
      logger.info(`Found ${securityDiags.length} security/quality diagnostics`);
    }
  }

  // Real-time analysis on text change (debounced — 1500ms for WASM solc compilation)
  let textChangeTimer: NodeJS.Timeout | undefined;
  const textChangeDisposable = vscode.workspace.onDidChangeTextDocument(async (event) => {
    const editor = vscode.window.activeTextEditor;
    if (editor && editor.document === event.document) {
      if (textChangeTimer) {
        clearTimeout(textChangeTimer);
      }
      textChangeTimer = setTimeout(() => {
        updateDecorations(editor);
      }, 1500); // 1500ms debounce on keystroke changes (was 300ms — too aggressive for WASM solc)
    }
  });

  // Run security analysis on file save (not on every keystroke)
  const documentSaveDisposable = vscode.workspace.onDidSaveTextDocument(async (document) => {
    const editor = vscode.window.activeTextEditor;
    if (editor && editor.document === document) {
      runSecurityAnalysis(editor);
    }
  });

  // Track open/close of solidity files so the analysis engine can manage its eviction interval
  const docOpenDisposable = vscode.workspace.onDidOpenTextDocument((doc) => {
    if (doc.languageId === 'solidity') {
      realtimeAnalyzer.trackSolidityFile();
    }
  });
  const docCloseDisposable = vscode.workspace.onDidCloseTextDocument((doc) => {
    if (doc.languageId === 'solidity') {
      realtimeAnalyzer.untrackSolidityFile(doc.uri.toString());
    }
  });

  // Count already-open solidity documents
  for (const doc of vscode.workspace.textDocuments) {
    if (doc.languageId === 'solidity') {
      realtimeAnalyzer.trackSolidityFile();
    }
  }

  // Update decorations when switching editors (treat as file open for immediate response)
  // Note: onDidOpenTextDocument is NOT needed — onDidChangeActiveTextEditor already fires
  // when a new file is opened, and having both causes redundant compilations.
  const editorChangeDisposable = vscode.window.onDidChangeActiveTextEditor(async (editor) => {
    if (editor) {
      await updateDecorations(editor, true); // true = treat as file open
      runSecurityAnalysis(editor); // also trigger security analysis on file open
    }
  });

  // Trigger initial analysis for currently open editor (deferred so activate() returns fast)
  if (vscode.window.activeTextEditor) {
    const initialEditor = vscode.window.activeTextEditor;
    setTimeout(() => {
      updateDecorations(initialEditor, true);
      runSecurityAnalysis(initialEditor);
    }, 500);
  }

  // Extended analysis commands (on-demand only, runs when idle - never parallel with solc)
  const storageLayoutCommand = vscode.commands.registerCommand(
    'sigscan.showStorageLayout',
    async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.languageId !== 'solidity') {
        vscode.window.showErrorMessage('Open a Solidity file to analyze storage layout');
        return;
      }

      // Check if heavy analysis is running
      if (realtimeAnalyzer.isAnalysisInProgress()) {
        vscode.window.showWarningMessage('Analysis in progress, please wait...');
        return;
      }

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Analyzing storage layout...',
          cancellable: false,
        },
        async () => {
          const layout = await realtimeAnalyzer.analyzeStorageLayout(editor.document);
          const analyzers = await realtimeAnalyzer.getExtendedAnalyzers();
          const report = analyzers.storage.generateReport(layout, editor.document.fileName);

          const doc = await vscode.workspace.openTextDocument({
            content: report,
            language: 'markdown',
          });
          await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
        }
      );
    }
  );

  const callGraphCommand = vscode.commands.registerCommand('sigscan.showCallGraph', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'solidity') {
      vscode.window.showErrorMessage('Open a Solidity file to analyze call graph');
      return;
    }

    if (realtimeAnalyzer.isAnalysisInProgress()) {
      vscode.window.showWarningMessage('Analysis in progress, please wait...');
      return;
    }

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Building call graph...',
        cancellable: false,
      },
      async () => {
        const callGraph = await realtimeAnalyzer.analyzeCallGraph(editor.document);
        const analyzers = await realtimeAnalyzer.getExtendedAnalyzers();
        const report = analyzers.callGraph.generateReport(callGraph, editor.document.fileName);

        const doc = await vscode.workspace.openTextDocument({
          content: report,
          language: 'markdown',
        });
        await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
      }
    );
  });

  const deploymentCostCommand = vscode.commands.registerCommand(
    'sigscan.showDeploymentCost',
    async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.languageId !== 'solidity') {
        vscode.window.showErrorMessage('Open a Solidity file to estimate deployment cost');
        return;
      }

      if (realtimeAnalyzer.isAnalysisInProgress()) {
        vscode.window.showWarningMessage('Analysis in progress, please wait...');
        return;
      }

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Estimating deployment cost...',
          cancellable: false,
        },
        async () => {
          const cost = await realtimeAnalyzer.estimateDeploymentCost(editor.document);
          const analyzers = await realtimeAnalyzer.getExtendedAnalyzers();

          const analysis = {
            contracts: [cost],
            totalGas: cost.deploymentGas.total,
            totalCost: cost.costInEth,
            largestContract: cost.contractName,
            recommendations: [],
          };
          const report = analyzers.deployment.generateReport(analysis);

          const doc = await vscode.workspace.openTextDocument({
            content: report,
            language: 'markdown',
          });
          await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
        }
      );
    }
  );

  const regressionCommand = vscode.commands.registerCommand(
    'sigscan.compareWithBranch',
    async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.languageId !== 'solidity') {
        vscode.window.showErrorMessage('Open a Solidity file to compare gas usage');
        return;
      }

      if (realtimeAnalyzer.isAnalysisInProgress()) {
        vscode.window.showWarningMessage('Analysis in progress, please wait...');
        return;
      }

      const branch = await vscode.window.showInputBox({
        prompt: 'Enter branch/commit to compare with',
        value: 'main',
      });

      if (!branch) {
        return;
      }

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Comparing gas usage...',
          cancellable: false,
        },
        async () => {
          const regressionReport = await realtimeAnalyzer.compareWithBranch(
            editor.document,
            branch
          );

          if (!regressionReport) {
            vscode.window.showErrorMessage('Not a git repository or no data available');
            return;
          }

          const analyzers = await realtimeAnalyzer.getExtendedAnalyzers();
          const report = analyzers.regression.generateReport(regressionReport);

          const doc = await vscode.workspace.openTextDocument({
            content: report,
            language: 'markdown',
          });
          await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
        }
      );
    }
  );

  const profilerCommand = vscode.commands.registerCommand(
    'sigscan.showProfilerReport',
    async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.languageId !== 'solidity') {
        vscode.window.showErrorMessage('Open a Solidity file to see profiler report');
        return;
      }

      if (realtimeAnalyzer.isAnalysisInProgress()) {
        vscode.window.showWarningMessage('Analysis in progress, please wait...');
        return;
      }

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Loading profiler data...',
          cancellable: false,
        },
        async () => {
          const profilerReport = await realtimeAnalyzer.getProfilerReport(editor.document);

          if (!profilerReport) {
            vscode.window.showInformationMessage(
              'No forge test data found. Run `forge test --gas-report` first.'
            );
            return;
          }

          const analyzers = await realtimeAnalyzer.getExtendedAnalyzers();
          const report = analyzers.profiler.generateReport(profilerReport);

          const doc = await vscode.workspace.openTextDocument({
            content: report,
            language: 'markdown',
          });
          await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
        }
      );
    }
  );

  // Add to context
  context.subscriptions.push(
    treeView,
    hoverProvider,
    selectorHover,
    notebookSerializer,
    notebookController,
    textChangeDisposable,
    documentSaveDisposable,
    docOpenDisposable,
    docCloseDisposable,
    editorChangeDisposable,
    diagnosticCollection,
    gasDecorationType,
    complexityDecorationType,
    remixGasDecorationType,
    statusBarItem,
    storageLayoutCommand,
    callGraphCommand,
    deploymentCostCommand,
    regressionCommand,
    profilerCommand,
    codeLensDisposable,
    snippetCompletion,
    ...commands,
    ...newCommands
  );

  // Auto-scan on activation if enabled (deferred so activate() returns instantly)
  setTimeout(() => {
    const config = vscode.workspace.getConfiguration('sigscan');
    if (config.get('autoScan', true)) {
      sigScanManager.scanProject();
    }
  }, 100);

  // Set context for when clauses
  vscode.commands.executeCommand('setContext', 'sigscan:hasContracts', true);
}

export function deactivate() {
  if (sigScanManager) {
    sigScanManager.dispose();
  }
  if (realtimeAnalyzer) {
    realtimeAnalyzer.dispose();
  }
  if (gasDecorationManager) {
    gasDecorationManager.dispose();
  }
  if (_anvilManager && _anvilManager.isRunning()) {
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    _anvilManager.stop().catch(() => {});
  }
  if (_forkSimulator && _forkSimulator.isRunning()) {
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    _forkSimulator.stopFork().catch(() => {});
  }
  compilationService.dispose();
}
