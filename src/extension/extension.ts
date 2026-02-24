import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { SigScanManager } from './manager';
import { SignatureTreeProvider } from './providers/treeProvider';
import { logger } from '../utils/logger';

let sigScanManager: SigScanManager;
let signatureTreeProvider: SignatureTreeProvider;

import { RealtimeAnalyzer } from '../features/realtime';

// New Remix-style compilation imports
import { compilationService } from '../features/compilation-service';
import { GasDecorationManager } from '../features/gas-decorations';

// New feature imports (Phase 6-9)
import { CollisionDetector } from '../features/collision-detector';
import { InterfaceChecker } from '../features/interface-check';
import { GasOptimizer } from '../features/gas-optimizer';
import { CoverageAnalyzer } from '../features/coverage';
import { UpgradeAnalyzer } from '../features/upgrade-analyzer';
import { InvariantDetector } from '../features/invariant-detector';
import { MEVAnalyzer } from '../features/mev-analyzer';
import { GasSnapshotManager } from '../features/gas-snapshot';
import { GasPricingService } from '../features/gas-pricing';
import { FourByteLookup } from '../features/four-byte-lookup';
import { TestGenerator } from '../features/test-generator';
import { SelectorHoverProvider } from './providers/selector-hover-provider';
import { PlaygroundPanel } from './providers/playground';
import { DashboardPanel } from './providers/dashboard';
import {
  SigScanNotebookSerializer,
  SigScanNotebookController,
} from './providers/notebook-provider';

let realtimeAnalyzer: RealtimeAnalyzer;
let gasDecorationType: vscode.TextEditorDecorationType;
let complexityDecorationType: vscode.TextEditorDecorationType;
let remixGasDecorationType: vscode.TextEditorDecorationType;
let statusBarItem: vscode.StatusBarItem;
let gasDecorationManager: GasDecorationManager;

export function activate(context: vscode.ExtensionContext) {
  // Initialize structured logger
  logger.init(context);
  logger.info('SigScan extension activated');

  // Show visible notification
  vscode.window.showInformationMessage(
    ' SigScan Gas and Signature Analysis activated! Open a .sol file to see gas estimates.'
  );

  // Initialize manager
  sigScanManager = new SigScanManager(context);
  signatureTreeProvider = new SignatureTreeProvider(sigScanManager);

  // Initialize real-time analyzer
  const diagnosticCollection = vscode.languages.createDiagnosticCollection('sigscan');
  realtimeAnalyzer = new RealtimeAnalyzer(diagnosticCollection);

  // Initialize Remix-style gas decoration manager
  gasDecorationManager = GasDecorationManager.getInstance(300); // 300ms debounce

  // Create decoration types for gas and complexity hints
  // IMPORTANT: Need at least an empty 'after' object for dynamic renderOptions to work
  gasDecorationType = vscode.window.createTextEditorDecorationType({
    after: {
      margin: '0 0 0 1em',
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
      color: '#6A9955',
      margin: '0 0 0 1em',
    },
  });

  // Create status bar item
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.text = '$(flame) Gas Analysis';
  statusBarItem.tooltip = 'SigScan: Real-time gas analysis active';
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

  compilationService.on('compilation:success', ({ output }) => {
    logger.info(`Compilation successful: ${output.gasInfo.length} functions analyzed`);
    statusBarItem.text = '$(flame) Gas Analysis';
    // Decorations are applied by updateDecorations() which awaits compile() — no need to duplicate here
  });

  compilationService.on('compilation:error', ({ errors }) => {
    logger.error(`Compilation failed: ${errors[0]}`);
    statusBarItem.text = '$(flame) Gas Analysis';
    // Fallback decorations are applied by updateDecorations() which handles compilation errors
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
      vscode.window.showInformationMessage('SigScan: Started watching for file changes');
    }),

    vscode.commands.registerCommand('sigscan.stopWatching', () => {
      sigScanManager.stopWatching();
      vscode.window.showInformationMessage('SigScan: Stopped watching for file changes');
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

  const collisionDetector = new CollisionDetector();
  const interfaceChecker = new InterfaceChecker();
  const gasOptimizer = new GasOptimizer();
  const coverageAnalyzer = new CoverageAnalyzer();
  const upgradeAnalyzer = new UpgradeAnalyzer();
  const invariantDetector = new InvariantDetector();
  const mevAnalyzer = new MEVAnalyzer();
  const gasSnapshotManager = new GasSnapshotManager();
  const gasPricingService = new GasPricingService();
  const fourByteLookup = new FourByteLookup();
  const testGenerator = new TestGenerator();
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
      const allResults = interfaceChecker.checkAllContracts(contracts);
      const parts: string[] = ['# Interface Compliance Report\n'];
      allResults.forEach((results, contractName) => {
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
      const snapshot = await gasSnapshotManager.createSnapshot(gasData, workspaceFolder.uri.fsPath);
      const filePath = path.join(workspaceFolder.uri.fsPath, '.sigscan-snapshot.json');
      gasSnapshotManager.exportSnapshot(snapshot, filePath);
      vscode.window.showInformationMessage(`Gas snapshot saved to ${filePath}`);
    }),

    // Gas pricing
    vscode.commands.registerCommand('sigscan.showGasPricing', async () => {
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
      const testContent = testGenerator.generateTestFile(contractInfo);
      const doc = await vscode.workspace.openTextDocument({
        content: testContent,
        language: 'solidity',
      });
      await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
    }),

    // Playground webview
    vscode.commands.registerCommand('sigscan.openPlayground', () => {
      PlaygroundPanel.createOrShow(context.extensionUri);
    }),

    // Dashboard webview
    vscode.commands.registerCommand('sigscan.openDashboard', () => {
      DashboardPanel.createOrShow(context.extensionUri);
    }),
  ];

  // Register selector hover provider
  const selectorHover = vscode.languages.registerHoverProvider(
    { scheme: 'file', pattern: '**/*' },
    selectorHoverProvider
  );

  // Register notebook serializer
  const notebookSerializer = vscode.workspace.registerNotebookSerializer(
    SigScanNotebookController.notebookType,
    new SigScanNotebookSerializer()
  );
  const _notebookController = new SigScanNotebookController();

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
          'Realtime analysis disabled in settings - enable with "SigScan: Toggle Real-time Gas Analysis"'
        );
        lastDisabledLogTime = now;
      }
      return;
    }

    if (editor.document.languageId === 'solidity') {
      const uri = editor.document.uri.toString();
      const source = editor.document.getText();
      const fileName = path.basename(editor.document.uri.fsPath);

      logger.info(`Compiling ${fileName}...`);

      // Use Remix-style compilation service directly
      const trigger = isFileOpenEvent ? 'file-open' : 'manual';

      try {
        const result = await compilationService.compile(uri, source, trigger, (importPath) => {
          // Import resolver - tries multiple common paths
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
        } else if (!result.success) {
          logger.error(`Compilation failed and no functions extracted: ${result.errors[0]}`);
        } else {
          logger.warn('Compilation succeeded but no gas info extracted');
        }
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

  // Real-time analysis on text change (debounced to avoid excessive calls during typing)
  let textChangeTimer: NodeJS.Timeout | undefined;
  const textChangeDisposable = vscode.workspace.onDidChangeTextDocument(async (event) => {
    const editor = vscode.window.activeTextEditor;
    if (editor && editor.document === event.document) {
      if (textChangeTimer) {
        clearTimeout(textChangeTimer);
      }
      textChangeTimer = setTimeout(() => {
        updateDecorations(editor);
      }, 300); // 300ms debounce on keystroke changes
    }
  });

  // Update decorations when switching editors (treat as file open for immediate response)
  const editorChangeDisposable = vscode.window.onDidChangeActiveTextEditor(async (editor) => {
    if (editor) {
      await updateDecorations(editor, true); // true = treat as file open
    }
  });

  // Update decorations when opening a document
  const documentOpenDisposable = vscode.workspace.onDidOpenTextDocument(async (document) => {
    const editor = vscode.window.activeTextEditor;
    if (editor && editor.document === document) {
      await updateDecorations(editor, true); // true = file open event
    }
  });

  // Trigger initial analysis for currently open editor (treat as file open)
  if (vscode.window.activeTextEditor) {
    updateDecorations(vscode.window.activeTextEditor, true);
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
    textChangeDisposable,
    editorChangeDisposable,
    documentOpenDisposable,
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
    ...commands,
    ...newCommands
  );

  // Auto-scan on activation if enabled
  const config = vscode.workspace.getConfiguration('sigscan');
  if (config.get('autoScan', true)) {
    sigScanManager.scanProject();
  }

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
  compilationService.dispose();
}
