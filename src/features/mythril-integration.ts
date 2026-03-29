/**
 * Mythril Integration — Symbolic execution via Mythril (myth) CLI
 *
 * Runs mythril on a Solidity file, parses JSON output,
 * maps findings to VS Code diagnostics, and generates markdown reports.
 *
 * Mythril is an optional external dependency — graceful degradation
 * when not installed.
 */

import * as path from 'path';
import { execFile } from 'child_process';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MythrilIssue {
  title: string;
  swcID: string;
  swcTitle: string;
  description: string;
  severity: 'High' | 'Medium' | 'Low';
  address: number;
  sourceMap?: string;
  filename?: string;
  lineno?: number;
  code?: string;
}

export interface MythrilDiagnostic {
  file: string;
  line: number;
  severity: 'error' | 'warning' | 'info';
  message: string;
  code: string;
}

// ---------------------------------------------------------------------------
// Raw Mythril JSON output shape
// ---------------------------------------------------------------------------

interface MythrilJsonOutput {
  success: boolean;
  error?: string | null;
  issues?: Array<{
    title?: string;
    swcID?: string;
    swcTitle?: string;
    description?: string;
    severity?: string;
    address?: number;
    sourceMap?: string;
    filename?: string;
    lineno?: number;
    code?: string;
    function?: string;
    type?: string;
    debug?: string;
    extra?: Record<string, unknown>;
  }>;
}

// ---------------------------------------------------------------------------
// MythrilIntegration
// ---------------------------------------------------------------------------

export class MythrilIntegration {
  private mythPath: string;

  constructor(mythPath?: string) {
    this.mythPath = mythPath || 'myth';
  }

  /**
   * Check if mythril is installed and accessible.
   */
  async isAvailable(): Promise<boolean> {
    return new Promise((resolve) => {
      execFile(this.mythPath, ['version'], { timeout: 15_000 }, (err) => {
        if (err) {
          // myth might use --version instead
          execFile(this.mythPath, ['--version'], { timeout: 10_000 }, (err2) => {
            resolve(!err2);
          });
          return;
        }
        resolve(true);
      });
    });
  }

  /**
   * Run mythril analysis on a Solidity file.
   *
   * @param filePath - Path to a .sol file
   * @param options  - Analysis options (timeout, depth, solc version)
   * @returns Array of MythrilIssue objects
   */
  async analyze(
    filePath: string,
    options?: {
      timeout?: number;
      executionTimeout?: number;
      maxDepth?: number;
      solcVersion?: string;
    }
  ): Promise<MythrilIssue[]> {
    const timeout = options?.timeout ?? 300;
    const executionTimeout = options?.executionTimeout ?? 86400;
    const maxDepth = options?.maxDepth ?? 22;

    return new Promise((resolve, reject) => {
      const args = [
        'analyze',
        filePath,
        '-o',
        'json',
        '--execution-timeout',
        String(executionTimeout),
        '--max-depth',
        String(maxDepth),
      ];

      if (options?.solcVersion) {
        args.push('--solv', options.solcVersion);
      }

      execFile(
        this.mythPath,
        args,
        {
          timeout: (timeout + 30) * 1000, // Give myth time to finish + buffer
          maxBuffer: 10 * 1024 * 1024, // 10MB
          cwd: path.dirname(filePath),
        },
        (err, stdout, stderr) => {
          const output = stdout?.trim();

          if (!output) {
            if (err) {
              // Check if it's just a timeout or actual error
              if (err.killed || (err as any).code === 'ETIMEDOUT') {
                reject(new Error(`Mythril analysis timed out after ${timeout}s`));
              } else {
                // Mythril may write to stderr for warnings but still succeed
                reject(new Error(`Mythril failed: ${stderr || err.message}`));
              }
            } else {
              resolve([]);
            }
            return;
          }

          try {
            const parsed = this.tryParseJson(output);
            const issues = this.parseIssues(parsed, filePath);
            resolve(issues);
          } catch (parseErr) {
            reject(new Error(`Failed to parse mythril output: ${parseErr}`));
          }
        }
      );
    });
  }

  /**
   * Convert issues to VS Code-compatible diagnostics.
   */
  toDiagnostics(issues: MythrilIssue[]): MythrilDiagnostic[] {
    const diagnostics: MythrilDiagnostic[] = [];

    for (const issue of issues) {
      const severity = this.mapSeverityToDiag(issue.severity);
      const file = issue.filename || '';
      const line = issue.lineno || 1;

      const swcRef = issue.swcID ? ` [SWC-${issue.swcID}]` : '';
      const message = `${issue.title}${swcRef}: ${issue.description}`;

      diagnostics.push({
        file,
        line,
        severity,
        message,
        code: issue.swcID
          ? `SWC-${issue.swcID}`
          : `mythril-${issue.title.toLowerCase().replace(/\s+/g, '-')}`,
      });
    }

    return diagnostics;
  }

  /**
   * Generate a markdown report from issues.
   */
  generateReport(issues: MythrilIssue[]): string {
    const lines: string[] = [
      '# Mythril Symbolic Execution Report',
      '',
      `**Total issues:** ${issues.length}`,
      '',
    ];

    if (issues.length === 0) {
      lines.push('No vulnerabilities found.');
      return lines.join('\n');
    }

    // Summary table
    const highCount = issues.filter((i) => i.severity === 'High').length;
    const mediumCount = issues.filter((i) => i.severity === 'Medium').length;
    const lowCount = issues.filter((i) => i.severity === 'Low').length;

    lines.push('## Summary');
    lines.push('');
    lines.push('| Severity | Count |');
    lines.push('|----------|-------|');
    if (highCount > 0) {
      lines.push(`| High | ${highCount} |`);
    }
    if (mediumCount > 0) {
      lines.push(`| Medium | ${mediumCount} |`);
    }
    if (lowCount > 0) {
      lines.push(`| Low | ${lowCount} |`);
    }
    lines.push('');

    // Group by severity
    const groups: Array<{
      label: string;
      severity: MythrilIssue['severity'];
      icon: string;
    }> = [
      { label: 'High Severity', severity: 'High', icon: '[!]' },
      { label: 'Medium Severity', severity: 'Medium', icon: '[*]' },
      { label: 'Low Severity', severity: 'Low', icon: '[-]' },
    ];

    for (const group of groups) {
      const groupIssues = issues.filter((i) => i.severity === group.severity);
      if (groupIssues.length === 0) {
        continue;
      }

      lines.push(`## ${group.icon} ${group.label} (${groupIssues.length})`);
      lines.push('');

      for (const issue of groupIssues) {
        lines.push(`### ${issue.title}`);
        lines.push('');

        if (issue.swcID) {
          lines.push(
            `**SWC ID:** [SWC-${issue.swcID}](https://swcregistry.io/docs/SWC-${issue.swcID}) — ${issue.swcTitle}`
          );
          lines.push('');
        }

        lines.push(`**Severity:** ${issue.severity}`);
        lines.push('');

        lines.push(issue.description);
        lines.push('');

        if (issue.filename && issue.lineno) {
          lines.push(`**Location:** \`${issue.filename}:${issue.lineno}\``);
          lines.push('');
        }

        if (issue.code) {
          lines.push('**Vulnerable code:**');
          lines.push('```solidity');
          lines.push(issue.code);
          lines.push('```');
          lines.push('');
        }

        if (issue.address !== undefined) {
          lines.push(`**EVM Program Counter:** ${issue.address}`);
          lines.push('');
        }

        lines.push('---');
        lines.push('');
      }
    }

    // SWC reference section
    const swcIds = [...new Set(issues.filter((i) => i.swcID).map((i) => i.swcID))];
    if (swcIds.length > 0) {
      lines.push('## SWC References');
      lines.push('');
      for (const swcId of swcIds) {
        const issue = issues.find((i) => i.swcID === swcId);
        lines.push(
          `- **SWC-${swcId}**: [${issue?.swcTitle || swcId}](https://swcregistry.io/docs/SWC-${swcId})`
        );
      }
      lines.push('');
    }

    lines.push('');
    lines.push('*Report generated by 0xTools Mythril integration*');

    return lines.join('\n');
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /**
   * Try to parse JSON from mythril output, handling potential extra text.
   */
  private tryParseJson(output: string): MythrilJsonOutput {
    // First try direct parse
    try {
      return JSON.parse(output);
    } catch {
      // Mythril may output multiple JSON objects or extra text
    }

    // Try to find JSON object in output
    const jsonStart = output.indexOf('{');
    const jsonEnd = output.lastIndexOf('}');
    if (jsonStart >= 0 && jsonEnd > jsonStart) {
      try {
        return JSON.parse(output.substring(jsonStart, jsonEnd + 1));
      } catch {
        // Fall through
      }
    }

    // Try to find JSON array (mythril sometimes outputs bare array)
    const arrayStart = output.indexOf('[');
    const arrayEnd = output.lastIndexOf(']');
    if (arrayStart >= 0 && arrayEnd > arrayStart) {
      try {
        const issues = JSON.parse(output.substring(arrayStart, arrayEnd + 1));
        return { success: true, issues };
      } catch {
        // Fall through
      }
    }

    throw new Error('No valid JSON found in mythril output');
  }

  /**
   * Parse the raw mythril JSON output into MythrilIssue objects.
   */
  private parseIssues(output: MythrilJsonOutput, filePath: string): MythrilIssue[] {
    if (!output.issues || !Array.isArray(output.issues)) {
      return [];
    }

    return output.issues.map((issue) => ({
      title: issue.title || 'Unknown Issue',
      swcID: issue.swcID || '',
      swcTitle: issue.swcTitle || '',
      description: issue.description || '',
      severity: this.normalizeSeverity(issue.severity),
      address: issue.address ?? 0,
      sourceMap: issue.sourceMap,
      filename: issue.filename || filePath,
      lineno: issue.lineno,
      code: issue.code,
    }));
  }

  /**
   * Normalize severity string to typed enum value.
   */
  private normalizeSeverity(severity: string | undefined): MythrilIssue['severity'] {
    const normalized = (severity || '').toLowerCase();
    if (normalized === 'high') {
      return 'High';
    }
    if (normalized === 'medium') {
      return 'Medium';
    }
    return 'Low';
  }

  /**
   * Map mythril severity to VS Code diagnostic severity.
   */
  private mapSeverityToDiag(severity: MythrilIssue['severity']): MythrilDiagnostic['severity'] {
    switch (severity) {
      case 'High':
        return 'error';
      case 'Medium':
        return 'warning';
      case 'Low':
        return 'info';
    }
  }
}
