/* eslint-disable @typescript-eslint/no-var-requires */
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { ProjectScanner, SubProject } from '../core/scanner';
import { SignatureExporter } from '../core/exporter';
import { FileWatcher } from '../core/watcher';
import { ScanResult, ExportOptions } from '../types';
import type { SignatureEntry } from '../features/database';

export class SigScanManager {
  private scanner: ProjectScanner;
  private exporter: SignatureExporter;
  private watcher: FileWatcher;
  private context: vscode.ExtensionContext;
  private lastScanResult: ScanResult | null = null;
  private subProjects: SubProject[] = [];

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    this.scanner = new ProjectScanner();
    this.exporter = new SignatureExporter();
    this.watcher = new FileWatcher();

    this.setupWatcherEvents();
  }

  /**
   * Scan the current workspace for contracts (including all subprojects)
   */
  public async scanProject(): Promise<void> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      vscode.window.showErrorMessage('No workspace folder found');
      return;
    }

    const rootPath = workspaceFolders[0].uri.fsPath;

    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Scanning contracts...',
          cancellable: false,
        },
        async (progress) => {
          progress.report({ increment: 0, message: 'Finding subprojects...' });

          // Scan all subprojects
          const { subProjects, combinedResult } = await this.scanner.scanAllSubProjects(rootPath);
          this.subProjects = subProjects;
          this.lastScanResult = combinedResult;

          if (combinedResult.totalContracts === 0) {
            vscode.window.showWarningMessage('No Solidity contracts found in the workspace.');
            return;
          }

          progress.report({ increment: 50, message: 'Exporting signatures to subprojects...' });

          // Auto-export signatures to each subproject's own signatures folder
          await this.autoExportSignaturesToSubProjects();

          progress.report({ increment: 50, message: 'Scan completed' });

          const projectCount = subProjects.length;
          vscode.window.showInformationMessage(
            `Scan completed: ${projectCount} project(s), ${combinedResult.totalContracts} contracts, ${combinedResult.totalFunctions} functions. Signatures saved to each project's 'signatures' folder.`
          );

          // Auto-start watching if configured
          const config = vscode.workspace.getConfiguration('sigscan');
          if (config.get('autoScan', true)) {
            this.startWatching();
          }
        }
      );
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      vscode.window.showErrorMessage(`Error scanning project: ${errorMessage}`);
    }
  }

  /**
   * Start watching for file changes
   */
  public startWatching(): void {
    if (!this.lastScanResult) {
      vscode.window.showWarningMessage('Please scan the project first');
      return;
    }

    // Watch each subproject
    for (const subProject of this.subProjects) {
      if (subProject.scanResult) {
        this.watcher.startWatching(subProject.scanResult.projectInfo);
      }
    }
  }

  /**
   * Stop watching for file changes
   */
  public stopWatching(): void {
    this.watcher.stopWatching();
  }

  /**
   * Auto-export signatures to each subproject's folder
   */
  private async autoExportSignaturesToSubProjects(): Promise<void> {
    if (this.subProjects.length === 0) {
      return;
    }

    const config = vscode.workspace.getConfiguration('sigscan');
    const formats = config.get('outputFormats', ['txt', 'json']) as string[];
    const includeInternal = !config.get('excludeInternal', true);
    const includePrivate = config.get('includePrivate', false) as boolean;

    for (const subProject of this.subProjects) {
      if (!subProject.scanResult || subProject.scanResult.totalContracts === 0) {
        continue;
      }

      // Create signatures folder in each subproject
      const outputDir = path.join(subProject.path, 'signatures');

      const exportOptions: ExportOptions = {
        formats: formats as any,
        outputDir,
        includeInternal,
        includePrivate,
        includeEvents: true,
        includeErrors: true,
        separateByCategory: true,
        updateExisting: true,
        deduplicateSignatures: true,
      };

      try {
        await this.exporter.exportSignatures(subProject.scanResult, exportOptions);
      } catch (error) {
        console.error(`Auto-export error for ${subProject.path}:`, error);
      }
    }
  }

  /**
   * Auto-export signatures with default settings (legacy - uses combined result)
   */
  private async autoExportSignatures(): Promise<void> {
    // Use subprojects export instead
    await this.autoExportSignaturesToSubProjects();
  }

  /**
   * Export signatures to files (exports to each subproject)
   */
  public async exportSignatures(): Promise<void> {
    if (!this.lastScanResult) {
      vscode.window.showWarningMessage('Please scan the project first');
      return;
    }

    if (this.lastScanResult.totalContracts === 0) {
      vscode.window.showWarningMessage('No Solidity contracts found in the workspace.');
      return;
    }

    const config = vscode.workspace.getConfiguration('sigscan');
    const formats = config.get<string[]>('outputFormats', ['txt', 'json']);
    const includeInternal = !config.get<boolean>('excludeInternal', true);
    const includePrivate = !config.get<boolean>('excludePrivate', true);

    try {
      // Export to each subproject
      const exportedDirs: string[] = [];

      for (const subProject of this.subProjects) {
        if (!subProject.scanResult || subProject.scanResult.totalContracts === 0) {
          continue;
        }

        const outputDir = path.join(subProject.path, 'signatures');

        const exportOptions: ExportOptions = {
          formats: formats as any,
          outputDir,
          includeInternal,
          includePrivate,
          includeEvents: true,
          includeErrors: true,
          separateByCategory: true,
          updateExisting: true,
          deduplicateSignatures: true,
        };

        await this.exporter.exportSignatures(subProject.scanResult, exportOptions);
        exportedDirs.push(outputDir);
      }

      vscode.window.showInformationMessage(
        `Signatures exported to ${exportedDirs.length} project(s)!`
      );
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      vscode.window.showErrorMessage(`Error exporting signatures: ${errorMessage}`);
    }
  }

  /**
   * Refresh signatures (re-scan)
   */
  public async refreshSignatures(): Promise<void> {
    await this.scanProject();
  }

  /**
   * Provide hover information for Solidity functions
   */
  public provideHover(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.ProviderResult<vscode.Hover> {
    if (!this.lastScanResult || !document.fileName.endsWith('.sol')) {
      return null;
    }

    const wordRange = document.getWordRangeAtPosition(position);
    if (!wordRange) {
      return null;
    }

    const word = document.getText(wordRange);

    // Find matching function signatures
    const matches: string[] = [];
    this.lastScanResult.projectInfo.contracts.forEach((contract) => {
      contract.functions.forEach((func) => {
        if (func.name === word) {
          matches.push(`**${func.signature}** → \`${func.selector}\``);
        }
      });
    });

    if (matches.length > 0) {
      const content = new vscode.MarkdownString();
      content.appendMarkdown('**Function Signatures:**\n\n');
      content.appendMarkdown(matches.join('\n\n'));
      return new vscode.Hover(content);
    }

    return null;
  }

  /**
   * Get last scan result
   */
  public getLastScanResult(): ScanResult | null {
    return this.lastScanResult;
  }

  /**
   * Setup watcher event handlers
   */
  private setupWatcherEvents(): void {
    this.watcher.on('fileChanged', async (filePath, contractInfo) => {
      if (contractInfo && this.lastScanResult) {
        this.lastScanResult.projectInfo.contracts.set(filePath, contractInfo);
        vscode.window.showInformationMessage(`Contract updated: ${path.basename(filePath)}`);

        // Auto-update signatures when file changes
        await this.autoExportSignatures();
      }
    });

    this.watcher.on('fileAdded', async (filePath, contractInfo) => {
      if (contractInfo && this.lastScanResult) {
        this.lastScanResult.projectInfo.contracts.set(filePath, contractInfo);
        vscode.window.showInformationMessage(`New contract detected: ${path.basename(filePath)}`);

        // Auto-update signatures when file is added
        await this.autoExportSignatures();
      }
    });

    this.watcher.on('fileRemoved', async (filePath) => {
      if (this.lastScanResult) {
        this.lastScanResult.projectInfo.contracts.delete(filePath);
        vscode.window.showInformationMessage(`Contract removed: ${path.basename(filePath)}`);

        // Auto-update signatures when file is removed
        await this.autoExportSignatures();
      }
    });

    this.watcher.on('error', (error) => {
      vscode.window.showErrorMessage(`File watcher error: ${error.message}`);
    });
  }

  /**
   * Generate ABI for all contracts
   */
  public async generateABI(): Promise<void> {
    if (!this.lastScanResult) {
      vscode.window.showWarningMessage('No scan results available. Run scan first.');
      return;
    }

    try {
      const { ABIGenerator } = require('../features/abi');
      const generator = new ABIGenerator();
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders) {
        return;
      }
      const outputDir = path.join(workspaceFolders[0].uri.fsPath, 'abi');

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Generating ABI files...',
          cancellable: false,
        },
        async (progress) => {
          let processed = 0;
          const total = this.lastScanResult?.projectInfo.contracts.size || 0;

          for (const [, contract] of this.lastScanResult?.projectInfo.contracts || []) {
            const abi = generator.generateABI(contract);
            // Save ABI to file
            if (!fs.existsSync(outputDir)) {
              fs.mkdirSync(outputDir, { recursive: true });
            }
            const abiPath = path.join(outputDir, `${contract.name}.json`);
            fs.writeFileSync(abiPath, JSON.stringify(abi, null, 2));

            processed++;
            progress.report({ increment: total > 0 ? 100 / total : 100 });
          }
        }
      );

      vscode.window.showInformationMessage(`ABI files generated in ${outputDir}`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      vscode.window.showErrorMessage(`Error generating ABI: ${errorMessage}`);
    }
  }

  /**
   * Estimate gas costs for all contracts
   */
  public async estimateGas(): Promise<void> {
    if (!this.lastScanResult) {
      vscode.window.showWarningMessage('No scan results available. Run scan first.');
      return;
    }

    try {
      const { GasEstimator } = require('../features/gas');
      const estimator = new GasEstimator();
      const results: Array<{ contract: string; function: string; estimate: number }> = [];

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Estimating gas costs...',
          cancellable: false,
        },
        async (progress) => {
          let processed = 0;
          const total = this.lastScanResult?.projectInfo.contracts.size || 0;

          for (const [contractPath, contract] of this.lastScanResult?.projectInfo.contracts || []) {
            const contractCode = fs.existsSync(contractPath)
              ? fs.readFileSync(contractPath, 'utf-8')
              : '';
            for (const func of contract.functions) {
              const gasEstimate = await estimator.estimateGas(
                '',
                func.signature,
                contractPath,
                contractCode
              );
              results.push({
                contract: contract.name,
                function: func.signature,
                estimate:
                  gasEstimate.estimatedGas.average === 'infinite'
                    ? Infinity
                    : gasEstimate.estimatedGas.average,
              });
            }
            processed++;
            progress.report({ increment: 100 / total });
          }
        }
      );

      // Show results in output channel
      const outputChannel = vscode.window.createOutputChannel('0xTools Gas Estimates');
      outputChannel.clear();
      outputChannel.appendLine('=== Gas Estimates ===\n');

      results.sort((a, b) => b.estimate - a.estimate);
      results.forEach(({ contract, function: func, estimate }) => {
        outputChannel.appendLine(`${contract}.${func}: ${estimate.toLocaleString()} gas`);
      });

      outputChannel.show();
      vscode.window.showInformationMessage(
        `Gas estimates generated for ${results.length} functions`
      );
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      vscode.window.showErrorMessage(`Error estimating gas: ${errorMessage}`);
    }
  }

  /**
   * Check contract sizes
   */
  public async checkContractSize(): Promise<void> {
    if (!this.lastScanResult) {
      vscode.window.showWarningMessage('No scan results available. Run scan first.');
      return;
    }

    try {
      const { ContractSizeAnalyzer } = require('../features/size');
      const analyzer = new ContractSizeAnalyzer();
      const results: Array<{ contract: string; size: number; withinLimit: boolean }> = [];

      for (const [contractPath, contract] of this.lastScanResult.projectInfo.contracts) {
        // Read contract source code
        const contractCode = fs.existsSync(contractPath)
          ? fs.readFileSync(contractPath, 'utf-8')
          : '';
        const result = analyzer.analyzeContract(contract.name, contractCode);
        results.push({
          contract: contract.name,
          size: result.estimatedSize,
          withinLimit: result.status === 'safe' || result.status === 'warning',
        });
      }

      // Show results
      const outputChannel = vscode.window.createOutputChannel('0xTools Contract Sizes');
      outputChannel.clear();
      outputChannel.appendLine('=== Contract Size Analysis ===\n');
      outputChannel.appendLine(`EIP-170 Limit: 24,576 bytes\n`);

      results.sort((a, b) => b.size - a.size);
      results.forEach(({ contract, size, withinLimit }) => {
        const status = withinLimit ? '✓' : '✗ EXCEEDS LIMIT';
        outputChannel.appendLine(`${status} ${contract}: ${size.toLocaleString()} bytes`);
      });

      outputChannel.show();

      const oversized = results.filter((r) => !r.withinLimit);
      if (oversized.length > 0) {
        vscode.window
          .showWarningMessage(`${oversized.length} contract(s) exceed size limit!`, 'View Details')
          .then((selection) => {
            if (selection === 'View Details') {
              outputChannel.show();
            }
          });
      } else {
        vscode.window.showInformationMessage('All contracts within size limits');
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      vscode.window.showErrorMessage(`Error checking contract size: ${errorMessage}`);
    }
  }

  /**
   * Analyze code complexity
   */
  public async analyzeComplexity(): Promise<void> {
    if (!this.lastScanResult) {
      vscode.window.showWarningMessage('No scan results available. Run scan first.');
      return;
    }

    try {
      const { ComplexityAnalyzer } = require('../features/complexity');
      const analyzer = new ComplexityAnalyzer();
      const results: Array<{
        contract: string;
        function: string;
        complexity: number;
        rating: string;
      }> = [];

      for (const [contractPath, contract] of this.lastScanResult.projectInfo.contracts) {
        // Read contract source code once per contract
        const contractCode = fs.existsSync(contractPath)
          ? fs.readFileSync(contractPath, 'utf-8')
          : '';

        for (const func of contract.functions) {
          // Use the entire contract code as approximation (ideally extract function body)
          const result = analyzer.analyzeFunction(contractCode, func.name);
          results.push({
            contract: contract.name,
            function: func.signature,
            complexity: result.cyclomaticComplexity,
            rating: result.rating,
          });
        }
      }

      // Show results
      const outputChannel = vscode.window.createOutputChannel('0xTools Complexity Analysis');
      outputChannel.clear();
      outputChannel.appendLine('=== Cyclomatic Complexity Analysis ===\n');
      outputChannel.appendLine(
        'Ratings: Low (1-5) | Medium (6-10) | High (11-20) | Very High (21+)\n'
      );

      results.sort((a, b) => b.complexity - a.complexity);
      results.forEach(({ contract, function: func, complexity, rating }) => {
        outputChannel.appendLine(`[${rating}] ${contract}.${func}: ${complexity}`);
      });

      outputChannel.show();

      const highComplexity = results.filter((r) => r.complexity > 10);
      if (highComplexity.length > 0) {
        vscode.window
          .showWarningMessage(
            `${highComplexity.length} function(s) have high complexity`,
            'View Details'
          )
          .then((selection) => {
            if (selection === 'View Details') {
              outputChannel.show();
            }
          });
      } else {
        vscode.window.showInformationMessage('All functions have acceptable complexity');
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      vscode.window.showErrorMessage(`Error analyzing complexity: ${errorMessage}`);
    }
  }

  /**
   * Verify contract on Etherscan
   */
  public async verifyEtherscan(): Promise<void> {
    if (!this.lastScanResult) {
      vscode.window.showWarningMessage('No scan results available. Run scan first.');
      return;
    }

    const config = vscode.workspace.getConfiguration('sigscan');
    const apiKey = config.get<string>('etherscanApiKey');

    if (!apiKey) {
      const result = await vscode.window.showErrorMessage(
        'Etherscan API key not configured',
        'Configure'
      );
      if (result === 'Configure') {
        vscode.commands.executeCommand('workbench.action.openSettings', 'sigscan.etherscanApiKey');
      }
      return;
    }

    // Get contract address from user
    const address = await vscode.window.showInputBox({
      prompt: 'Enter deployed contract address',
      placeHolder: '0x...',
      validateInput: (value) => {
        if (!value.match(/^0x[a-fA-F0-9]{40}$/)) {
          return 'Invalid Ethereum address';
        }
        return null;
      },
    });

    if (!address) {
      return;
    }

    // Get network
    const network = await vscode.window.showQuickPick(['mainnet', 'sepolia', 'polygon', 'bsc'], {
      placeHolder: 'Select network',
    });

    if (!network) {
      return;
    }

    try {
      const config = { apiKey, network: network as 'mainnet' | 'sepolia' | 'polygon' | 'bsc' };
      const { EtherscanVerifier } = require('../features/verify');
      const verifier = new EtherscanVerifier(config);

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Verifying contract on Etherscan...',
          cancellable: false,
        },
        async () => {
          // Verify the first contract
          const contracts = Array.from(this.lastScanResult?.projectInfo.contracts.values() || []);
          const firstContract = contracts[0];
          if (firstContract) {
            await verifier.verifyContract(address, firstContract);
          }
        }
      );

      vscode.window.showInformationMessage('Contract verification submitted to Etherscan');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      vscode.window.showErrorMessage(`Error verifying contract: ${errorMessage}`);
    }
  }

  /**
   * Search signature database
   */
  public async searchDatabase(): Promise<void> {
    const query = await vscode.window.showInputBox({
      prompt: 'Search function signature or selector',
      placeHolder: 'e.g., transfer(address,uint256) or 0xa9059cbb',
    });

    if (!query) {
      return;
    }

    try {
      const { SignatureDatabase } = require('../features/database');
      const db = new SignatureDatabase();
      const results = await db.search(query);

      if (results.length === 0) {
        vscode.window.showInformationMessage('No matching signatures found');
        return;
      }

      // Show results in quick pick
      const items = results.map((r: SignatureEntry) => ({
        label: r.signature,
        description: r.selector,
        detail: `Category: ${r.category} - ${r.description}`,
      }));

      const selected = await vscode.window.showQuickPick(items, {
        placeHolder: `Found ${results.length} matching signature(s)`,
      });

      if (selected) {
        await vscode.env.clipboard.writeText((selected as any).label);
        vscode.window.showInformationMessage(`Copied: ${(selected as any).label}`);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      vscode.window.showErrorMessage(`Error searching database: ${errorMessage}`);
    }
  }

  /**
   * Generate all reports (comprehensive analysis)
   */
  public async generateAllReports(): Promise<void> {
    if (!this.lastScanResult) {
      vscode.window.showWarningMessage('No scan results available. Run scan first.');
      return;
    }

    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Generating comprehensive reports...',
          cancellable: false,
        },
        async (progress) => {
          progress.report({ message: 'Generating ABI...', increment: 0 });
          await this.generateABI();

          progress.report({ message: 'Estimating gas...', increment: 25 });
          await this.estimateGas();

          progress.report({ message: 'Checking sizes...', increment: 25 });
          await this.checkContractSize();

          progress.report({ message: 'Analyzing complexity...', increment: 25 });
          await this.analyzeComplexity();

          progress.report({ message: 'Complete!', increment: 25 });
        }
      );

      vscode.window.showInformationMessage('All reports generated successfully');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      vscode.window.showErrorMessage(`Error generating reports: ${errorMessage}`);
    }
  }

  /**
   * Dispose resources
   */
  public dispose(): void {
    this.watcher.stopWatching();
  }
}
