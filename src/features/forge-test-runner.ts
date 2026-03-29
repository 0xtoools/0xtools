/**
 * Forge Test Runner — CodeLens provider for inline "Run Test" buttons
 *
 * Adds clickable CodeLens above test functions and test contracts
 * in Foundry projects. Shows pass/fail and gas usage inline.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { execSync } from 'child_process';
import { logger } from '../utils/logger';

// Pre-compiled regexes for CodeLens (provideCodeLenses runs on every scroll/edit)
const CONTRACT_PATTERN = /contract\s+(\w+)\s+is\s+Test/;
const TEST_FN_PATTERN = /function\s+(test\w*)\s*\(/;

interface TestResult {
  name: string;
  passed: boolean;
  gasUsed: number;
  reason?: string;
  duration?: number;
}

export class ForgeTestCodeLensProvider implements vscode.CodeLensProvider {
  private _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
  public readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;

  // Cache test results per file
  private testResults = new Map<string, Map<string, TestResult>>();
  private runningTests = new Set<string>();

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (document.languageId !== 'solidity') {
      return [];
    }

    // Only provide for test files
    const fileName = path.basename(document.uri.fsPath);
    if (!fileName.endsWith('.t.sol') && !fileName.includes('Test')) {
      return [];
    }

    const codeLenses: vscode.CodeLens[] = [];
    const text = document.getText();
    const lines = text.split('\n');
    const fileResults = this.testResults.get(document.uri.toString());

    // Find test contract
    for (let i = 0; i < lines.length; i++) {
      const contractMatch = CONTRACT_PATTERN.exec(lines[i]);
      if (contractMatch) {
        const range = new vscode.Range(i, 0, i, lines[i].length);

        // "Run All Tests" lens for the contract
        codeLenses.push(
          new vscode.CodeLens(range, {
            title: '$(play) Run All Tests',
            command: 'sigscan.forgeRunAllTests',
            arguments: [document.uri],
          })
        );
        break;
      }
    }

    // Find individual test functions
    for (let i = 0; i < lines.length; i++) {
      const testMatch = TEST_FN_PATTERN.exec(lines[i]);
      if (testMatch) {
        const testName = testMatch[1];
        const range = new vscode.Range(i, 0, i, lines[i].length);
        const isRunning = this.runningTests.has(`${document.uri.toString()}:${testName}`);

        // Run single test lens
        if (isRunning) {
          codeLenses.push(
            new vscode.CodeLens(range, {
              title: '$(sync~spin) Running...',
              command: '',
            })
          );
        } else {
          codeLenses.push(
            new vscode.CodeLens(range, {
              title: '$(play) Run Test',
              command: 'sigscan.forgeRunTest',
              arguments: [document.uri, testName],
            })
          );
        }

        // Show result if available
        const result = fileResults?.get(testName);
        if (result) {
          const gasStr =
            result.gasUsed >= 1000
              ? `${(result.gasUsed / 1000).toFixed(1)}k`
              : result.gasUsed.toString();

          if (result.passed) {
            codeLenses.push(
              new vscode.CodeLens(range, {
                title: `$(check) Passed (${gasStr} gas)`,
                command: '',
              })
            );
          } else {
            const reason = result.reason ? `: ${result.reason.substring(0, 50)}` : '';
            codeLenses.push(
              new vscode.CodeLens(range, {
                title: `$(x) Failed${reason}`,
                command: '',
              })
            );
          }
        }
      }
    }

    return codeLenses;
  }

  /**
   * Run a single forge test
   */
  async runTest(uri: vscode.Uri, testName: string): Promise<void> {
    const key = `${uri.toString()}:${testName}`;
    this.runningTests.add(key);
    this._onDidChangeCodeLenses.fire();

    try {
      const filePath = uri.fsPath;
      const fileName = path.basename(filePath);

      // Find project root
      const projectRoot = this.findProjectRoot(filePath);
      if (!projectRoot) {
        vscode.window.showErrorMessage('Could not find foundry.toml. Is this a Foundry project?');
        return;
      }

      const terminal = vscode.window.createTerminal({
        name: `Forge: ${testName}`,
        cwd: projectRoot,
      });

      // Use forge test with match-test
      const cmd = `forge test --match-test "${testName}" --match-path "${fileName}" -vvv`;
      terminal.sendText(cmd);
      terminal.show(true);

      // Also run in background to capture results
      const result = await this.executeForgeTest(projectRoot, testName, fileName);
      if (result) {
        if (!this.testResults.has(uri.toString())) {
          this.testResults.set(uri.toString(), new Map());
        }
        this.testResults.get(uri.toString())!.set(testName, result);
      }
    } catch (error) {
      logger.error(`Forge test error: ${error}`);
    } finally {
      this.runningTests.delete(key);
      this._onDidChangeCodeLenses.fire();
    }
  }

  /**
   * Run all tests in a file
   */
  async runAllTests(uri: vscode.Uri): Promise<void> {
    const filePath = uri.fsPath;
    const fileName = path.basename(filePath);
    const projectRoot = this.findProjectRoot(filePath);

    if (!projectRoot) {
      vscode.window.showErrorMessage('Could not find foundry.toml. Is this a Foundry project?');
      return;
    }

    const terminal = vscode.window.createTerminal({
      name: `Forge: ${fileName}`,
      cwd: projectRoot,
    });

    terminal.sendText(`forge test --match-path "${fileName}" -vvv --gas-report`);
    terminal.show(true);
  }

  /**
   * Execute forge test and parse output
   */
  private async executeForgeTest(
    projectRoot: string,
    testName: string,
    fileName: string
  ): Promise<TestResult | null> {
    try {
      const output = execSync(
        `forge test --match-test "${testName}" --match-path "${fileName}" --json 2>/dev/null`,
        { cwd: projectRoot, timeout: 60000, encoding: 'utf-8' }
      );

      const parsed = JSON.parse(output);

      // Navigate forge JSON output to find test result
      for (const file of Object.values(parsed) as any[]) {
        for (const contract of Object.values(file) as any[]) {
          if (contract.test_results) {
            for (const [name, result] of Object.entries(contract.test_results) as any[]) {
              if (name === testName || name.includes(testName)) {
                return {
                  name,
                  passed: result.status === 'Success',
                  gasUsed: result.gas || 0,
                  reason: result.reason || undefined,
                };
              }
            }
          }
        }
      }
    } catch (error: any) {
      // Test failed — try to parse error output
      try {
        if (error.stdout) {
          const parsed = JSON.parse(error.stdout);
          for (const file of Object.values(parsed) as any[]) {
            for (const contract of Object.values(file) as any[]) {
              if (contract.test_results) {
                for (const [name, result] of Object.entries(contract.test_results) as any[]) {
                  if (name === testName || name.includes(testName)) {
                    return {
                      name,
                      passed: false,
                      gasUsed: result.gas || 0,
                      reason: result.reason || 'Test failed',
                    };
                  }
                }
              }
            }
          }
        }
      } catch {
        // Can't parse — that's fine, terminal output will show details
      }

      return {
        name: testName,
        passed: false,
        gasUsed: 0,
        reason: 'Execution failed',
      };
    }

    return null;
  }

  /**
   * Find the Foundry project root
   */
  private findProjectRoot(filePath: string): string | null {
    let dir = path.dirname(filePath);
    while (dir !== path.dirname(dir)) {
      if (fs.existsSync(path.join(dir, 'foundry.toml'))) {
        return dir;
      }
      dir = path.dirname(dir);
    }
    return null;
  }

  /**
   * Clear cached results
   */
  clearResults(): void {
    this.testResults.clear();
    this._onDidChangeCodeLenses.fire();
  }
}
