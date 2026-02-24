/**
 * Analysis Engine - Core analysis orchestration, caching, scheduling
 *
 * Extracted from realtime.ts. This is the "brain" that manages:
 * - Signature extraction (immediate, no solc)
 * - Solc compilation scheduling (idle-based)
 * - Content-hash caching
 * - Extended analysis (storage, call-graph, deployment)
 * - Remix-style compilation via CompilationService
 *
 * Decoration creation is delegated to decoration-manager.ts.
 * Resource gating is delegated to resource-monitor.ts.
 */

import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';
import { GasEstimator, GasEstimate } from './gas';
import { ContractSizeAnalyzer, ContractSizeInfo } from './size';
import { ComplexityAnalyzer, ComplexityMetrics } from './complexity';
import { SolidityParser } from '../core/parser';
import { FunctionSignature } from '../types';
// Types only — actual modules are lazy-loaded via dynamic import()
import type { StorageLayoutAnalyzer, StorageLayout } from './storage-layout';
import type { CallGraphAnalyzer, CallGraph } from './call-graph';
import type { DeploymentCostEstimator, DeploymentCost } from './deployment';
import type { GasRegressionTracker, RegressionReport } from './regression';
import type { RuntimeProfiler, ProfilerReport } from './profiler';
import { checkResourcesAvailable } from './resource-monitor';

import { GasInfo, CompilationOutput } from './SolcManager';
import { compilationService, CompilationResult } from './compilation-service';

// Import decoration functions for delegation
import {
  createGasDecorations as _createGasDecorations,
  createRemixStyleDecorations as _createRemixStyleDecorations,
  createComplexityDecorations as _createComplexityDecorations,
  createGasInlayHints as _createGasInlayHints,
  createHoverInfo as _createHoverInfo,
} from './decoration-manager';

// Re-export decoration creators so callers can import from one place
export {
  createGasDecorations,
  createRemixStyleDecorations,
  createComplexityDecorations,
  createGasInlayHints,
  createHoverInfo,
  getGasGradientColor,
  getComplexityColor,
} from './decoration-manager';

export interface LiveAnalysis {
  gasEstimates: Map<string, GasEstimate>;
  sizeInfo: ContractSizeInfo | null;
  complexityMetrics: Map<string, ComplexityMetrics>;
  diagnostics: vscode.Diagnostic[];
  isPending?: boolean;
  storageLayout?: StorageLayout;
  callGraph?: CallGraph;
  deploymentCost?: DeploymentCost;
  regressionReport?: RegressionReport;
  profilerReport?: ProfilerReport;
  gasInfo?: GasInfo[];
}

export interface AnalysisReadyEvent {
  uri: string;
  analysis: LiveAnalysis;
}

export interface RemixCompilationEvent {
  uri: string;
  output: CompilationOutput;
  gasInfo: GasInfo[];
}

export class AnalysisEngine extends EventEmitter {
  private solcGasEstimator: GasEstimator;
  private sizeAnalyzer: ContractSizeAnalyzer;
  private complexityAnalyzer: ComplexityAnalyzer;
  private parser: SolidityParser;
  private diagnosticCollection: vscode.DiagnosticCollection;
  private analysisCache: Map<string, { timestamp: number; analysis: LiveAnalysis }>;
  private solcResultsCache: Map<string, { analysis: LiveAnalysis; timestamp: number }>;
  private signatureCache: Map<string, { analysis: LiveAnalysis; timestamp: number }>;
  private idleTimers: Map<string, NodeJS.Timeout>;
  private activeSolcCompilations: Map<string, boolean>;
  private analysisInProgress = false;
  private extendedAnalysisInProgress = false;
  private _evictionInterval: NodeJS.Timeout | undefined;
  private static readonly CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
  private static readonly MAX_CACHE_SIZE = 50;

  // Extended analyzers (lazy-loaded on first use via dynamic import())
  private _storageAnalyzer: StorageLayoutAnalyzer | null = null;
  private _callGraphAnalyzer: CallGraphAnalyzer | null = null;
  private _deploymentAnalyzer: DeploymentCostEstimator | null = null;
  private _regressionTracker: GasRegressionTracker | null = null;
  private _runtimeProfiler: RuntimeProfiler | null = null;

  constructor(diagnosticCollection: vscode.DiagnosticCollection) {
    super();
    this.solcGasEstimator = new GasEstimator(true);
    this.sizeAnalyzer = new ContractSizeAnalyzer();
    this.complexityAnalyzer = new ComplexityAnalyzer();
    this.parser = new SolidityParser();
    this.diagnosticCollection = diagnosticCollection;
    this.analysisCache = new Map();
    this.solcResultsCache = new Map();
    this.signatureCache = new Map();

    // Periodically evict stale cache entries (every 60s)
    this._evictionInterval = setInterval(() => this.evictStaleCacheEntries(), 60_000);
    this.idleTimers = new Map();
    this.activeSolcCompilations = new Map();
  }

  // ─── Lazy loader helpers ─────────────────────────────────────────────────

  private async getStorageAnalyzer(): Promise<StorageLayoutAnalyzer> {
    if (!this._storageAnalyzer) {
      const { StorageLayoutAnalyzer } = await import('./storage-layout');
      this._storageAnalyzer = new StorageLayoutAnalyzer();
    }
    return this._storageAnalyzer;
  }

  private async getCallGraphAnalyzer(): Promise<CallGraphAnalyzer> {
    if (!this._callGraphAnalyzer) {
      const { CallGraphAnalyzer } = await import('./call-graph');
      this._callGraphAnalyzer = new CallGraphAnalyzer();
    }
    return this._callGraphAnalyzer;
  }

  private async getDeploymentAnalyzer(): Promise<DeploymentCostEstimator> {
    if (!this._deploymentAnalyzer) {
      const { DeploymentCostEstimator } = await import('./deployment');
      this._deploymentAnalyzer = new DeploymentCostEstimator();
    }
    return this._deploymentAnalyzer;
  }

  private async getRegressionTracker(): Promise<GasRegressionTracker> {
    if (!this._regressionTracker) {
      const { GasRegressionTracker } = await import('./regression');
      this._regressionTracker = new GasRegressionTracker();
    }
    return this._regressionTracker;
  }

  private async getRuntimeProfiler(): Promise<RuntimeProfiler> {
    if (!this._runtimeProfiler) {
      const { RuntimeProfiler } = await import('./profiler');
      this._runtimeProfiler = new RuntimeProfiler();
    }
    return this._runtimeProfiler;
  }

  // ─── Document analysis ─────────────────────────────────────────────────────

  public async analyzeDocumentOnOpen(document: vscode.TextDocument): Promise<LiveAnalysis> {
    const content = document.getText();
    const uri = document.uri.toString();
    const contentHash = this.hashContent(content);

    this.analysisCache.delete(uri);

    const solcEntry = this.solcResultsCache.get(contentHash);
    if (
      solcEntry &&
      !solcEntry.analysis.isPending &&
      Date.now() - solcEntry.timestamp < AnalysisEngine.CACHE_TTL_MS
    ) {
      return solcEntry.analysis;
    }

    const signatureAnalysis = this.createSignatureOnlyAnalysis(document, contentHash);

    setImmediate(() => {
      this.runSolcAnalysis(document, contentHash).catch((err) => {
        console.error('Background solc compilation failed:', err);
      });
    });

    return signatureAnalysis;
  }

  public async analyzeDocumentOnChange(document: vscode.TextDocument): Promise<LiveAnalysis> {
    const content = document.getText();
    const contentHash = this.hashContent(content);

    const solcEntry = this.solcResultsCache.get(contentHash);
    if (
      solcEntry &&
      !solcEntry.analysis.isPending &&
      Date.now() - solcEntry.timestamp < AnalysisEngine.CACHE_TTL_MS
    ) {
      return solcEntry.analysis;
    }

    const signatureAnalysis = this.createSignatureOnlyAnalysis(document, contentHash);
    this.scheduleIdleSolcAnalysis(document, contentHash);
    return signatureAnalysis;
  }

  public getCachedAnalysis(document: vscode.TextDocument): LiveAnalysis | null {
    const content = document.getText();
    const contentHash = this.hashContent(content);

    const solcEntry = this.solcResultsCache.get(contentHash);
    if (
      solcEntry &&
      !solcEntry.analysis.isPending &&
      Date.now() - solcEntry.timestamp < AnalysisEngine.CACHE_TTL_MS
    ) {
      return solcEntry.analysis;
    }

    const sigEntry = this.signatureCache.get(contentHash);
    if (sigEntry && Date.now() - sigEntry.timestamp < AnalysisEngine.CACHE_TTL_MS) {
      return sigEntry.analysis;
    }

    return null;
  }

  /** @deprecated Use analyzeDocumentOnOpen or analyzeDocumentOnChange */
  public async analyzeDocument(document: vscode.TextDocument): Promise<LiveAnalysis> {
    return this.analyzeDocumentOnChange(document);
  }

  // ─── Signature-only analysis ───────────────────────────────────────────────

  private createSignatureOnlyAnalysis(
    document: vscode.TextDocument,
    contentHash: string
  ): LiveAnalysis {
    const cachedEntry = this.signatureCache.get(contentHash);
    if (cachedEntry && Date.now() - cachedEntry.timestamp < AnalysisEngine.CACHE_TTL_MS) {
      return cachedEntry.analysis;
    }

    const content = document.getText();
    const contractInfo = this.parser.parseContent(content, document.uri.fsPath);

    if (!contractInfo) {
      return this.createEmptyAnalysis(true);
    }

    const gasEstimates = new Map<string, GasEstimate>();
    for (const func of contractInfo.functions) {
      gasEstimates.set(func.name, {
        function: func.name,
        signature: func.signature,
        selector: func.selector,
        estimatedGas: { min: 0, max: 0, average: 0 },
        complexity: 'low',
        factors: ['Waiting for solc...'],
        source: 'heuristic',
      });
    }

    // Detect selector collisions
    const diagnostics: vscode.Diagnostic[] = [];
    const selectorMap = new Map<string, FunctionSignature[]>();
    for (const func of contractInfo.functions) {
      if (func.visibility === 'internal' || func.visibility === 'private') {
        continue;
      }
      if (func.name.startsWith('modifier:')) {
        continue;
      }
      const existing = selectorMap.get(func.selector) || [];
      existing.push(func);
      selectorMap.set(func.selector, existing);
    }

    for (const [selector, funcs] of selectorMap) {
      if (funcs.length < 2) {
        continue;
      }
      const names = funcs.map((f) => f.signature).join(', ');
      for (const func of funcs) {
        const pattern = new RegExp(`function\\s+${func.name}\\s*\\(`);
        const match = content.match(pattern);
        if (match && match.index !== undefined) {
          const line = content.substring(0, match.index).split('\n').length - 1;
          const diag = new vscode.Diagnostic(
            new vscode.Range(line, 0, line, 1000),
            `Selector collision: ${selector} is shared by ${names}`,
            vscode.DiagnosticSeverity.Warning
          );
          diag.source = 'SigScan';
          diagnostics.push(diag);
        }
      }
    }

    if (diagnostics.length > 0) {
      this.diagnosticCollection.set(document.uri, diagnostics);
    }

    const analysis: LiveAnalysis = {
      gasEstimates,
      sizeInfo: null,
      complexityMetrics: new Map(),
      diagnostics,
      isPending: true,
    };

    // Evict if cache is too large
    if (this.signatureCache.size >= AnalysisEngine.MAX_CACHE_SIZE) {
      const oldest = [...this.signatureCache.entries()].sort(
        (a, b) => a[1].timestamp - b[1].timestamp
      );
      for (let i = 0; i < Math.ceil(oldest.length * 0.2); i++) {
        this.signatureCache.delete(oldest[i][0]);
      }
    }
    this.signatureCache.set(contentHash, { analysis, timestamp: Date.now() });
    return analysis;
  }

  // ─── Solc compilation ──────────────────────────────────────────────────────

  private hashContent(content: string): string {
    return crypto.createHash('sha256').update(content).digest('hex');
  }

  private scheduleIdleSolcAnalysis(document: vscode.TextDocument, contentHash: string): void {
    const uri = document.uri.toString();
    const config = vscode.workspace.getConfiguration('sigscan');
    const idleMs = config.get<number>('realtime.solcIdleMs', 1000);

    const existingTimer = this.idleTimers.get(uri);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    if (this.activeSolcCompilations.get(uri)) {
      this.activeSolcCompilations.set(uri, false);
    }

    const timer = setTimeout(async () => {
      if (this.hashContent(document.getText()) === contentHash) {
        await this.runSolcAnalysis(document, contentHash);
      }
    }, idleMs);

    this.idleTimers.set(uri, timer);
  }

  public isAnalysisInProgress(): boolean {
    return (
      this.analysisInProgress ||
      Array.from(this.activeSolcCompilations.values()).some((active) => active)
    );
  }

  private async runSolcAnalysis(document: vscode.TextDocument, contentHash: string): Promise<void> {
    const uri = document.uri.toString();
    const content = document.getText();

    const cachedEntry = this.solcResultsCache.get(contentHash);
    if (
      cachedEntry &&
      !cachedEntry.analysis.isPending &&
      Date.now() - cachedEntry.timestamp < AnalysisEngine.CACHE_TTL_MS
    ) {
      return;
    }

    this.activeSolcCompilations.set(uri, true);
    this.analysisInProgress = true;

    try {
      const contractInfo = this.parser.parseContent(content, document.uri.fsPath);
      if (!contractInfo) {
        return;
      }

      if (!this.activeSolcCompilations.get(uri)) {
        return;
      }

      console.log(`Starting solc compilation for ${contractInfo.name}...`);

      const gasEstimates = new Map<string, GasEstimate>();
      const diagnostics: vscode.Diagnostic[] = [];

      const compileResult = await this.solcGasEstimator.estimateContractGas(
        content,
        contractInfo.functions,
        document.uri.fsPath
      );

      if (!this.activeSolcCompilations.get(uri)) {
        return;
      }

      for (const estimate of compileResult) {
        const funcName = estimate.signature.split('(')[0];
        gasEstimates.set(funcName, estimate);

        const avgGas = estimate.estimatedGas.average;
        const avgGasString = avgGas === 'infinite' ? '∞' : avgGas.toLocaleString();

        if (
          estimate.complexity === 'high' ||
          estimate.complexity === 'very-high' ||
          estimate.complexity === 'unbounded'
        ) {
          const funcPattern =
            funcName === 'constructor'
              ? /constructor\s*\([^)]*\)/s
              : new RegExp(`function\\s+${funcName}\\s*\\([^)]*\\)`, 's');
          const match = content.match(funcPattern);

          if (match) {
            const functionStart = content.indexOf(match[0]);
            const lines = content.substring(0, functionStart).split('\n').length - 1;

            const diagnostic = new vscode.Diagnostic(
              new vscode.Range(lines, 0, lines, 1000),
              `High gas cost (${avgGasString} gas): ${estimate.warning || estimate.factors.join(', ')}`,
              estimate.complexity === 'very-high' || estimate.complexity === 'unbounded'
                ? vscode.DiagnosticSeverity.Warning
                : vscode.DiagnosticSeverity.Information
            );
            diagnostic.source = 'SigScan Gas';
            diagnostics.push(diagnostic);
          }
        }
      }

      console.log(`Solc compilation complete: ${gasEstimates.size} functions analyzed`);

      this.diagnosticCollection.set(document.uri, diagnostics);

      const analysis: LiveAnalysis = {
        gasEstimates,
        sizeInfo: null,
        complexityMetrics: new Map(),
        diagnostics,
        isPending: false,
        gasInfo: [],
      };

      // Evict if cache is too large
      if (this.solcResultsCache.size >= AnalysisEngine.MAX_CACHE_SIZE) {
        const oldest = [...this.solcResultsCache.entries()].sort(
          (a, b) => a[1].timestamp - b[1].timestamp
        );
        for (let i = 0; i < Math.ceil(oldest.length * 0.2); i++) {
          this.solcResultsCache.delete(oldest[i][0]);
        }
      }
      this.solcResultsCache.set(contentHash, { analysis, timestamp: Date.now() });

      this.emit('analysisReady', { uri, analysis } as AnalysisReadyEvent);
    } catch (error) {
      console.error('Solc analysis error:', error);
    } finally {
      this.activeSolcCompilations.set(uri, false);
      this.analysisInProgress = false;
    }
  }

  // ─── Remix-style compilation ───────────────────────────────────────────────

  public async compileRemixStyle(
    document: vscode.TextDocument,
    trigger: 'file-save' | 'file-open' | 'optimizer-change' | 'pragma-change' | 'manual' = 'manual'
  ): Promise<CompilationResult> {
    const uri = document.uri.toString();
    const source = document.getText();

    const result = await compilationService.compile(uri, source, trigger, (importPath) => {
      return this.resolveImport(importPath, document);
    });

    if (result.success && result.gasInfo.length > 0) {
      this.emit('remixCompilationReady', {
        uri,
        output: result,
        gasInfo: result.gasInfo,
      } as RemixCompilationEvent);
    }

    return result;
  }

  public getRemixGasInfo(document: vscode.TextDocument): GasInfo[] {
    return compilationService.getGasInfo(document.uri.toString());
  }

  private resolveImport(
    importPath: string,
    document: vscode.TextDocument
  ): { contents: string } | { error: string } {
    try {
      const dir = path.dirname(document.uri.fsPath);
      let fullPath = path.resolve(dir, importPath);

      if (fs.existsSync(fullPath)) {
        return { contents: fs.readFileSync(fullPath, 'utf-8') };
      }

      fullPath = path.resolve(dir, 'node_modules', importPath);
      if (fs.existsSync(fullPath)) {
        return { contents: fs.readFileSync(fullPath, 'utf-8') };
      }

      fullPath = path.resolve(dir, 'lib', importPath);
      if (fs.existsSync(fullPath)) {
        return { contents: fs.readFileSync(fullPath, 'utf-8') };
      }

      const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
      if (workspaceFolder) {
        const wsPath = workspaceFolder.uri.fsPath;
        const libPaths = [
          path.resolve(wsPath, 'node_modules', importPath),
          path.resolve(wsPath, 'lib', importPath),
          path.resolve(wsPath, 'contracts', importPath),
        ];

        for (const libPath of libPaths) {
          if (fs.existsSync(libPath)) {
            return { contents: fs.readFileSync(libPath, 'utf-8') };
          }
        }
      }

      console.warn(`Import not found: ${importPath}`);
      return { error: `Import not found: ${importPath}` };
    } catch (error) {
      return { error: `Failed to read import: ${importPath}` };
    }
  }

  // ─── Compiler settings ─────────────────────────────────────────────────────

  public updateCompilerSettings(settings: {
    optimizer?: { enabled: boolean; runs: number };
    evmVersion?: string;
    viaIR?: boolean;
  }): void {
    compilationService.updateSettings(settings);
  }

  public getCompilerSettings(): {
    optimizer?: { enabled: boolean; runs: number };
    evmVersion?: string;
    viaIR?: boolean;
  } {
    return compilationService.getSettings();
  }

  public getCompilationStats(): {
    cacheSize: number;
    cachedVersions: string[];
    pendingCompilations: number;
  } {
    return compilationService.getStats();
  }

  // ─── Backward compatibility helpers ────────────────────────────────────────

  public gasInfoToEstimate(info: GasInfo): GasEstimate {
    const gasValue = info.gas === 'infinite' ? 'infinite' : info.gas;

    return {
      function: info.name,
      signature: info.name + '(...)',
      selector: info.selector,
      estimatedGas: { min: gasValue, max: gasValue, average: gasValue },
      complexity: this.classifyGasComplexity(info.gas),
      factors: info.warnings.length > 0 ? info.warnings : ['Standard execution'],
      warning: info.warnings.length > 0 ? info.warnings[0] : undefined,
      source: 'solc',
    };
  }

  private classifyGasComplexity(
    gas: number | 'infinite'
  ): 'low' | 'medium' | 'high' | 'very-high' | 'unbounded' {
    if (gas === 'infinite') {
      return 'unbounded';
    }
    if (gas < 50_000) {
      return 'low';
    }
    if (gas < 150_000) {
      return 'medium';
    }
    if (gas < 500_000) {
      return 'high';
    }
    return 'very-high';
  }

  // ─── Extended analysis ─────────────────────────────────────────────────────

  public async analyzeStorageLayout(document: vscode.TextDocument): Promise<StorageLayout> {
    const content = document.getText();
    const contractName = this.extractContractName(content);
    const analyzer = await this.getStorageAnalyzer();
    return analyzer.analyzeContract(content, contractName);
  }

  public async analyzeCallGraph(document: vscode.TextDocument): Promise<CallGraph> {
    const content = document.getText();
    const analyzer = await this.getCallGraphAnalyzer();
    return analyzer.analyzeContract(content);
  }

  public async estimateDeploymentCost(document: vscode.TextDocument): Promise<DeploymentCost> {
    const content = document.getText();
    const contractName = this.extractContractName(content);
    const analyzer = await this.getDeploymentAnalyzer();
    return analyzer.estimateContract(content, contractName);
  }

  private extractContractName(content: string): string {
    const match = content.match(/(contract|library|interface)\s+(\w+)/);
    return match ? match[2] : 'Unknown';
  }

  public async compareWithBranch(
    document: vscode.TextDocument,
    targetBranch = 'main'
  ): Promise<RegressionReport | null> {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
    if (!workspaceFolder) {
      return null;
    }

    const tracker = await this.getRegressionTracker();
    const isGit = await tracker.isGitRepository(workspaceFolder.uri.fsPath);
    if (!isGit) {
      return null;
    }

    const analysis = await this.analyzeDocumentOnChange(document);
    const gasData = new Map<
      string,
      { signature: string; gas: number; source: 'solc' | 'heuristic'; complexity: string }
    >();

    analysis.gasEstimates.forEach((estimate, funcName) => {
      gasData.set(funcName, {
        signature: estimate.signature,
        gas: typeof estimate.estimatedGas.average === 'number' ? estimate.estimatedGas.average : 0,
        source: estimate.source,
        complexity: estimate.complexity,
      });
    });

    return tracker.compareWithCommit(gasData, workspaceFolder.uri.fsPath, targetBranch);
  }

  public async getProfilerReport(document: vscode.TextDocument): Promise<ProfilerReport | null> {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
    if (!workspaceFolder) {
      return null;
    }

    const profiler = await this.getRuntimeProfiler();
    const forgeReports = await profiler.parseForgeGasReport(workspaceFolder.uri.fsPath);
    if (forgeReports.length === 0) {
      return null;
    }

    const analysis = await this.analyzeDocumentOnChange(document);
    const estimates = new Map<string, { gas: number; signature: string }>();

    analysis.gasEstimates.forEach((estimate, funcName) => {
      estimates.set(funcName, {
        gas: typeof estimate.estimatedGas.average === 'number' ? estimate.estimatedGas.average : 0,
        signature: estimate.signature,
      });
    });

    return profiler.compareEstimates(forgeReports, estimates);
  }

  public async getExtendedAnalyzers() {
    return {
      storage: await this.getStorageAnalyzer(),
      callGraph: await this.getCallGraphAnalyzer(),
      deployment: await this.getDeploymentAnalyzer(),
      regression: await this.getRegressionTracker(),
      profiler: await this.getRuntimeProfiler(),
    };
  }

  // ─── Extended analysis background runner ───────────────────────────────────

  private async runExtendedAnalysisIfAvailable(document: vscode.TextDocument): Promise<void> {
    if (this.extendedAnalysisInProgress || !checkResourcesAvailable(this.isAnalysisInProgress())) {
      return;
    }

    this.extendedAnalysisInProgress = true;

    try {
      const content = document.getText();
      const contractName = this.extractContractName(content);

      if (!contractName) {
        return;
      }

      try {
        if (checkResourcesAvailable(this.isAnalysisInProgress())) {
          const sa = await this.getStorageAnalyzer();
          sa.analyzeContract(content, contractName);
        }

        await new Promise((resolve) => setTimeout(resolve, 100));

        if (checkResourcesAvailable(this.isAnalysisInProgress())) {
          const cg = await this.getCallGraphAnalyzer();
          cg.analyzeContract(content);
        }

        await new Promise((resolve) => setTimeout(resolve, 100));

        if (checkResourcesAvailable(this.isAnalysisInProgress())) {
          const da = await this.getDeploymentAnalyzer();
          da.estimateContract(content, contractName);
        }
      } catch (error) {
        console.error('Extended analysis feature failed:', error);
      }
    } finally {
      this.extendedAnalysisInProgress = false;
    }
  }

  // ─── Decoration delegation (backward compat — instance methods) ─────────────

  public createGasDecorations(
    analysis: LiveAnalysis,
    document: vscode.TextDocument
  ): vscode.DecorationOptions[] {
    return _createGasDecorations(analysis, document);
  }

  public createRemixStyleDecorations(
    gasInfo: GasInfo[],
    document: vscode.TextDocument
  ): vscode.DecorationOptions[] {
    return _createRemixStyleDecorations(gasInfo, document);
  }

  public createComplexityDecorations(
    analysis: LiveAnalysis,
    document: vscode.TextDocument
  ): vscode.DecorationOptions[] {
    return _createComplexityDecorations(analysis, document);
  }

  public createGasInlayHints(
    analysis: LiveAnalysis,
    document: vscode.TextDocument
  ): vscode.InlayHint[] {
    return _createGasInlayHints(analysis, document);
  }

  public createHoverInfo(
    position: vscode.Position,
    analysis: LiveAnalysis,
    document: vscode.TextDocument
  ): vscode.Hover | null {
    return _createHoverInfo(position, analysis, document);
  }

  // ─── Cache management ──────────────────────────────────────────────────────

  public clearCache(uri: vscode.Uri): void {
    this.analysisCache.delete(uri.toString());
  }

  public clearAllCaches(): void {
    this.analysisCache.clear();
  }

  // ─── Dispose ───────────────────────────────────────────────────────────────

  public dispose(): void {
    if (this._evictionInterval) {
      clearInterval(this._evictionInterval);
    }

    for (const timer of this.idleTimers.values()) {
      clearTimeout(timer);
    }
    this.idleTimers.clear();

    for (const uri of this.activeSolcCompilations.keys()) {
      this.activeSolcCompilations.set(uri, false);
    }
    this.activeSolcCompilations.clear();

    this.analysisCache.clear();
    this.solcResultsCache.clear();
    this.signatureCache.clear();

    compilationService.dispose();
  }

  /**
   * Evict stale entries from solcResultsCache and signatureCache (TTL-based).
   */
  private evictStaleCacheEntries(): void {
    const now = Date.now();
    for (const [key, entry] of this.solcResultsCache) {
      if (now - entry.timestamp > AnalysisEngine.CACHE_TTL_MS) {
        this.solcResultsCache.delete(key);
      }
    }
    for (const [key, entry] of this.signatureCache) {
      if (now - entry.timestamp > AnalysisEngine.CACHE_TTL_MS) {
        this.signatureCache.delete(key);
      }
    }
  }

  private createEmptyAnalysis(isPending = false): LiveAnalysis {
    return {
      gasEstimates: new Map(),
      sizeInfo: null,
      complexityMetrics: new Map(),
      diagnostics: [],
      isPending,
    };
  }
}
