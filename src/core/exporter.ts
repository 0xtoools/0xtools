import * as fs from 'fs';
import * as path from 'path';
import {
  ScanResult,
  ExportOptions,
  FunctionSignature,
  EventSignature,
  ErrorSignature,
  ContractCategory,
  ContractInfo,
} from '../types';
import { shouldIncludeFunction, formatTimestamp, getFileExtension } from '../utils/helpers';

interface DeduplicatedSignatures {
  functions: Map<string, FunctionSignature>;
  events: Map<string, EventSignature>;
  errors: Map<string, ErrorSignature>;
}

export class SignatureExporter {
  /**
   * Export signatures to multiple formats with category separation and deduplication
   */
  public async exportSignatures(scanResult: ScanResult, options: ExportOptions): Promise<void> {
    // Check if any contracts were found
    if (scanResult.totalContracts === 0) {
      console.log('No Solidity contracts found in workspace. Skipping signature export.');
      return;
    }

    // Ensure output directory exists
    if (!fs.existsSync(options.outputDir)) {
      fs.mkdirSync(options.outputDir, { recursive: true });
    }

    // Add signatures/ to .gitignore
    await this.updateGitignore(scanResult.projectInfo.rootPath, options.outputDir);

    const separateByCategory = options.separateByCategory !== false; // Default to true
    const deduplicateSignatures = options.deduplicateSignatures !== false; // Default to true

    if (separateByCategory) {
      // Export by categories: contracts, libs, tests
      for (const category of ['contracts', 'libs', 'tests'] as ContractCategory[]) {
        const categoryContracts = scanResult.contractsByCategory.get(category) || [];
        if (categoryContracts.length > 0) {
          const categoryResult = this.createCategoryResult(scanResult, categoryContracts, category);

          for (const format of options.formats) {
            await this.exportCategoryToFormat(
              categoryResult,
              options,
              format,
              category,
              deduplicateSignatures
            );
          }
        }
      }
    } else {
      // Export all together (legacy mode)
      for (const format of options.formats) {
        await this.exportToFormat(scanResult, options, format, deduplicateSignatures);
      }
    }
  }

  /**
   * Create a result object for a specific category
   */
  private createCategoryResult(
    scanResult: ScanResult,
    categoryContracts: ContractInfo[],
    _category: ContractCategory
  ): ScanResult {
    const contractsMap = new Map<string, ContractInfo>();
    let totalFunctions = 0;
    let totalEvents = 0;
    let totalErrors = 0;

    categoryContracts.forEach((contract) => {
      contractsMap.set(contract.filePath, contract);
      totalFunctions += contract.functions.length;
      totalEvents += contract.events.length;
      totalErrors += contract.errors.length;
    });

    return {
      ...scanResult,
      projectInfo: {
        ...scanResult.projectInfo,
        contracts: contractsMap,
      },
      totalContracts: categoryContracts.length,
      totalFunctions,
      totalEvents,
      totalErrors,
    };
  }

  /**
   * Export category to specific format
   */
  private async exportCategoryToFormat(
    scanResult: ScanResult,
    options: ExportOptions,
    format: string,
    category: ContractCategory,
    deduplicateSignatures: boolean
  ): Promise<void> {
    const filename = `signatures-${category}${getFileExtension(format)}`;
    const filePath = path.join(options.outputDir, filename);

    let content = '';

    switch (format) {
      case 'txt':
        content = this.generateCategoryTextOutput(
          scanResult,
          options,
          category,
          deduplicateSignatures
        );
        break;
      case 'json':
        content = this.generateCategoryJsonOutput(
          scanResult,
          options,
          category,
          deduplicateSignatures
        );
        break;
      case 'csv':
        content = this.generateCategoryCsvOutput(
          scanResult,
          options,
          category,
          deduplicateSignatures
        );
        break;
      case 'md':
        content = this.generateCategoryMarkdownOutput(
          scanResult,
          options,
          category,
          deduplicateSignatures
        );
        break;
      default:
        throw new Error(`Unsupported format: ${format}`);
    }

    if (options.updateExisting !== false) {
      // Add update timestamp to beginning of file
      content = this.prependUpdateInfo(content, format);
    }

    fs.writeFileSync(filePath, content, 'utf-8');
  }

  /**
   * Export to specific format (legacy mode)
   */
  private async exportToFormat(
    scanResult: ScanResult,
    options: ExportOptions,
    format: string,
    deduplicateSignatures: boolean
  ): Promise<void> {
    const timestamp = formatTimestamp();
    const filename = `signatures_${timestamp}${getFileExtension(format)}`;
    const filePath = path.join(options.outputDir, filename);

    let content = '';

    switch (format) {
      case 'txt':
        content = this.generateTextOutput(scanResult, options, deduplicateSignatures);
        break;
      case 'json':
        content = this.generateJsonOutput(scanResult, options, deduplicateSignatures);
        break;
      case 'csv':
        content = this.generateCsvOutput(scanResult, options, deduplicateSignatures);
        break;
      case 'md':
        content = this.generateMarkdownOutput(scanResult, options, deduplicateSignatures);
        break;
      default:
        throw new Error(`Unsupported format: ${format}`);
    }

    fs.writeFileSync(filePath, content, 'utf-8');
  }

  /**
   * Deduplicate signatures across all contracts
   */
  private deduplicateSignatures(
    contracts: Map<string, ContractInfo>,
    options: ExportOptions
  ): DeduplicatedSignatures {
    const functions = new Map<string, FunctionSignature>();
    const events = new Map<string, EventSignature>();
    const errors = new Map<string, ErrorSignature>();

    contracts.forEach((contract) => {
      // Deduplicate functions
      const filteredFunctions = this.filterFunctions(contract.functions, options);
      filteredFunctions.forEach((func) => {
        functions.set(func.signature, func);
      });

      // Deduplicate events
      if (options.includeEvents) {
        contract.events.forEach((event) => {
          events.set(event.signature, event);
        });
      }

      // Deduplicate errors
      if (options.includeErrors) {
        contract.errors.forEach((error) => {
          errors.set(error.signature, error);
        });
      }
    });

    return { functions, events, errors };
  }

  /**
   * Generate category-specific text output
   */
  private generateCategoryTextOutput(
    scanResult: ScanResult,
    options: ExportOptions,
    category: ContractCategory,
    deduplicateSignatures: boolean
  ): string {
    const lines: string[] = [];

    lines.push('# Smart Contract Signatures');
    lines.push(`# Category: ${category.toUpperCase()}`);
    lines.push(`# Generated: ${scanResult.scanTime.toISOString()}`);
    lines.push(`# Project: ${scanResult.projectInfo.type} (${scanResult.projectInfo.rootPath})`);
    lines.push(`# Total Contracts in Category: ${scanResult.totalContracts}`);
    lines.push('');

    if (deduplicateSignatures) {
      // Contract-wise organization with deduplication
      const addedSignatures = new Set<string>();

      scanResult.projectInfo.contracts.forEach((contract) => {
        const contractFunctions: FunctionSignature[] = [];
        const contractEvents: EventSignature[] = [];
        const contractErrors: ErrorSignature[] = [];

        // Filter and deduplicate functions for this contract
        const functions = this.filterFunctions(contract.functions, options);
        functions.forEach((func) => {
          if (!addedSignatures.has(func.signature)) {
            contractFunctions.push(func);
            addedSignatures.add(func.signature);
          }
        });

        // Filter and deduplicate events for this contract
        if (options.includeEvents) {
          contract.events.forEach((event) => {
            if (!addedSignatures.has(event.signature)) {
              contractEvents.push(event);
              addedSignatures.add(event.signature);
            }
          });
        }

        // Filter and deduplicate errors for this contract
        if (options.includeErrors) {
          contract.errors.forEach((error) => {
            if (!addedSignatures.has(error.signature)) {
              contractErrors.push(error);
              addedSignatures.add(error.signature);
            }
          });
        }

        // Only show contract if it has unique signatures to contribute
        if (
          contractFunctions.length > 0 ||
          contractEvents.length > 0 ||
          contractErrors.length > 0
        ) {
          lines.push(`## Contract: ${contract.name} (${path.basename(contract.filePath)})`);
          lines.push('');

          // Functions
          if (contractFunctions.length > 0) {
            lines.push('### Functions:');
            contractFunctions.forEach((func) => {
              lines.push(`${func.signature.padEnd(40)} --> ${func.selector}`);
            });
            lines.push('');
          }

          // Events
          if (contractEvents.length > 0) {
            lines.push('### Events:');
            contractEvents.forEach((event) => {
              lines.push(`${event.signature.padEnd(40)} --> ${event.selector}`);
            });
            lines.push('');
          }

          // Errors
          if (contractErrors.length > 0) {
            lines.push('### Errors:');
            contractErrors.forEach((error) => {
              lines.push(`${error.signature.padEnd(40)} --> ${error.selector}`);
            });
            lines.push('');
          }
        }
      });
    } else {
      // Original contract-wise organization without deduplication
      scanResult.projectInfo.contracts.forEach((contract) => {
        lines.push(`## Contract: ${contract.name} (${path.basename(contract.filePath)})`);
        lines.push('');

        // Functions
        const functions = this.filterFunctions(contract.functions, options);
        if (functions.length > 0) {
          lines.push('### Functions:');
          functions.forEach((func) => {
            lines.push(`${func.signature.padEnd(40)} --> ${func.selector}`);
          });
          lines.push('');
        }

        // Events
        if (options.includeEvents && contract.events.length > 0) {
          lines.push('### Events:');
          contract.events.forEach((event) => {
            lines.push(`${event.signature.padEnd(40)} --> ${event.selector}`);
          });
          lines.push('');
        }

        // Errors
        if (options.includeErrors && contract.errors.length > 0) {
          lines.push('### Errors:');
          contract.errors.forEach((error) => {
            lines.push(`${error.signature.padEnd(40)} --> ${error.selector}`);
          });
          lines.push('');
        }
      });
    }

    return lines.join('\n');
  }

  /**
   * Generate category-specific JSON output
   */
  private generateCategoryJsonOutput(
    scanResult: ScanResult,
    options: ExportOptions,
    category: ContractCategory,
    deduplicateSignatures: boolean
  ): string {
    let output: any;

    if (deduplicateSignatures) {
      const deduplicated = this.deduplicateSignatures(scanResult.projectInfo.contracts, options);

      output = {
        metadata: {
          category: category,
          generatedAt: scanResult.scanTime.toISOString(),
          projectType: scanResult.projectInfo.type,
          projectPath: scanResult.projectInfo.rootPath,
          totalContractsInCategory: scanResult.totalContracts,
          uniqueFunctions: deduplicated.functions.size,
          uniqueEvents: deduplicated.events.size,
          uniqueErrors: deduplicated.errors.size,
        },
        signatures: {
          functions: Array.from(deduplicated.functions.values()),
          events: options.includeEvents ? Array.from(deduplicated.events.values()) : [],
          errors: options.includeErrors ? Array.from(deduplicated.errors.values()) : [],
        },
      };
    } else {
      output = {
        metadata: {
          category: category,
          generatedAt: scanResult.scanTime.toISOString(),
          projectType: scanResult.projectInfo.type,
          projectPath: scanResult.projectInfo.rootPath,
          totalContractsInCategory: scanResult.totalContracts,
          totalFunctions: scanResult.totalFunctions,
          totalEvents: scanResult.totalEvents,
          totalErrors: scanResult.totalErrors,
        },
        contracts: Array.from(scanResult.projectInfo.contracts.values()).map((contract) => ({
          name: contract.name,
          filePath: contract.filePath,
          category: contract.category,
          lastModified: contract.lastModified,
          functions: this.filterFunctions(contract.functions, options),
          events: options.includeEvents ? contract.events : [],
          errors: options.includeErrors ? contract.errors : [],
        })),
      };
    }

    return JSON.stringify(output, null, 2);
  }

  /**
   * Generate category-specific CSV output
   */
  private generateCategoryCsvOutput(
    scanResult: ScanResult,
    options: ExportOptions,
    category: ContractCategory,
    deduplicateSignatures: boolean
  ): string {
    const lines: string[] = [];

    // Header
    lines.push(
      'Type,Contract,Name,Signature,Selector,Visibility,StateMutability,FilePath,Category'
    );

    if (deduplicateSignatures) {
      const deduplicated = this.deduplicateSignatures(scanResult.projectInfo.contracts, options);

      // Functions
      Array.from(deduplicated.functions.values()).forEach((func) => {
        lines.push(
          [
            'Function',
            func.contractName,
            func.name,
            func.signature,
            func.selector,
            func.visibility,
            func.stateMutability,
            func.filePath,
            category,
          ]
            .map((field) => `"${field}"`)
            .join(',')
        );
      });

      // Events
      if (options.includeEvents) {
        Array.from(deduplicated.events.values()).forEach((event) => {
          lines.push(
            [
              'Event',
              event.contractName,
              event.name,
              event.signature,
              event.selector,
              '',
              '',
              event.filePath,
              category,
            ]
              .map((field) => `"${field}"`)
              .join(',')
          );
        });
      }

      // Errors
      if (options.includeErrors) {
        Array.from(deduplicated.errors.values()).forEach((error) => {
          lines.push(
            [
              'Error',
              error.contractName,
              error.name,
              error.signature,
              error.selector,
              '',
              '',
              error.filePath,
              category,
            ]
              .map((field) => `"${field}"`)
              .join(',')
          );
        });
      }
    } else {
      scanResult.projectInfo.contracts.forEach((contract) => {
        // Functions
        const functions = this.filterFunctions(contract.functions, options);
        functions.forEach((func) => {
          lines.push(
            [
              'Function',
              contract.name,
              func.name,
              func.signature,
              func.selector,
              func.visibility,
              func.stateMutability,
              contract.filePath,
              category,
            ]
              .map((field) => `"${field}"`)
              .join(',')
          );
        });

        // Events
        if (options.includeEvents) {
          contract.events.forEach((event) => {
            lines.push(
              [
                'Event',
                contract.name,
                event.name,
                event.signature,
                event.selector,
                '',
                '',
                contract.filePath,
                category,
              ]
                .map((field) => `"${field}"`)
                .join(',')
            );
          });
        }

        // Errors
        if (options.includeErrors) {
          contract.errors.forEach((error) => {
            lines.push(
              [
                'Error',
                contract.name,
                error.name,
                error.signature,
                error.selector,
                '',
                '',
                contract.filePath,
                category,
              ]
                .map((field) => `"${field}"`)
                .join(',')
            );
          });
        }
      });
    }

    return lines.join('\n');
  }

  /**
   * Generate category-specific Markdown output
   */
  private generateCategoryMarkdownOutput(
    scanResult: ScanResult,
    options: ExportOptions,
    category: ContractCategory,
    deduplicateSignatures: boolean
  ): string {
    const lines: string[] = [];

    lines.push('# Smart Contract Signatures');
    lines.push('');
    lines.push(`**Category:** ${category.toUpperCase()}`);
    lines.push(`**Generated:** ${scanResult.scanTime.toISOString()}`);
    lines.push(`**Project Type:** ${scanResult.projectInfo.type}`);
    lines.push(`**Project Path:** ${scanResult.projectInfo.rootPath}`);
    lines.push(`**Total Contracts in Category:** ${scanResult.totalContracts}`);
    lines.push('');

    if (deduplicateSignatures) {
      // Contract-wise organization with deduplication
      const addedSignatures = new Set<string>();

      scanResult.projectInfo.contracts.forEach((contract) => {
        const contractFunctions: FunctionSignature[] = [];
        const contractEvents: EventSignature[] = [];
        const contractErrors: ErrorSignature[] = [];

        // Filter and deduplicate functions for this contract
        const functions = this.filterFunctions(contract.functions, options);
        functions.forEach((func) => {
          if (!addedSignatures.has(func.signature)) {
            contractFunctions.push(func);
            addedSignatures.add(func.signature);
          }
        });

        // Filter and deduplicate events for this contract
        if (options.includeEvents) {
          contract.events.forEach((event) => {
            if (!addedSignatures.has(event.signature)) {
              contractEvents.push(event);
              addedSignatures.add(event.signature);
            }
          });
        }

        // Filter and deduplicate errors for this contract
        if (options.includeErrors) {
          contract.errors.forEach((error) => {
            if (!addedSignatures.has(error.signature)) {
              contractErrors.push(error);
              addedSignatures.add(error.signature);
            }
          });
        }

        // Only show contract if it has unique signatures to contribute
        if (
          contractFunctions.length > 0 ||
          contractEvents.length > 0 ||
          contractErrors.length > 0
        ) {
          lines.push(`## ${contract.name}`);
          lines.push('');
          lines.push(`**File:** \`${path.basename(contract.filePath)}\``);
          lines.push('');

          // Functions
          if (contractFunctions.length > 0) {
            lines.push('### Functions');
            lines.push('');
            lines.push('| Signature | Selector | Visibility | State Mutability |');
            lines.push('|-----------|----------|------------|-------------------|');

            contractFunctions.forEach((func) => {
              lines.push(
                `| \`${func.signature}\` | \`${func.selector}\` | ${func.visibility} | ${func.stateMutability} |`
              );
            });
            lines.push('');
          }

          // Events
          if (contractEvents.length > 0) {
            lines.push('### Events');
            lines.push('');
            lines.push('| Signature | Selector |');
            lines.push('|-----------|----------|');

            contractEvents.forEach((event) => {
              lines.push(`| \`${event.signature}\` | \`${event.selector}\` |`);
            });
            lines.push('');
          }

          // Errors
          if (contractErrors.length > 0) {
            lines.push('### Errors');
            lines.push('');
            lines.push('| Signature | Selector |');
            lines.push('|-----------|----------|');

            contractErrors.forEach((error) => {
              lines.push(`| \`${error.signature}\` | \`${error.selector}\` |`);
            });
            lines.push('');
          }
        }
      });
    } else {
      // Original contract-wise organization without deduplication
      scanResult.projectInfo.contracts.forEach((contract) => {
        lines.push(`## ${contract.name}`);
        lines.push('');
        lines.push(`**File:** \`${path.basename(contract.filePath)}\``);
        lines.push('');

        // Functions
        const functions = this.filterFunctions(contract.functions, options);
        if (functions.length > 0) {
          lines.push('### Functions');
          lines.push('');
          lines.push('| Signature | Selector | Visibility | State Mutability |');
          lines.push('|-----------|----------|------------|-------------------|');

          functions.forEach((func) => {
            lines.push(
              `| \`${func.signature}\` | \`${func.selector}\` | ${func.visibility} | ${func.stateMutability} |`
            );
          });
          lines.push('');
        }

        // Events
        if (options.includeEvents && contract.events.length > 0) {
          lines.push('### Events');
          lines.push('');
          lines.push('| Signature | Selector |');
          lines.push('|-----------|----------|');

          contract.events.forEach((event) => {
            lines.push(`| \`${event.signature}\` | \`${event.selector}\` |`);
          });
          lines.push('');
        }

        // Errors
        if (options.includeErrors && contract.errors.length > 0) {
          lines.push('### Errors');
          lines.push('');
          lines.push('| Signature | Selector |');
          lines.push('|-----------|----------|');

          contract.errors.forEach((error) => {
            lines.push(`| \`${error.signature}\` | \`${error.selector}\` |`);
          });
          lines.push('');
        }
      });
    }

    return lines.join('\n');
  }

  /**
   * Legacy text output generation
   */
  private generateTextOutput(
    scanResult: ScanResult,
    options: ExportOptions,
    deduplicateSignatures: boolean
  ): string {
    return this.generateCategoryTextOutput(scanResult, options, 'contracts', deduplicateSignatures);
  }

  /**
   * Legacy JSON output generation
   */
  private generateJsonOutput(
    scanResult: ScanResult,
    options: ExportOptions,
    deduplicateSignatures: boolean
  ): string {
    return this.generateCategoryJsonOutput(scanResult, options, 'contracts', deduplicateSignatures);
  }

  /**
   * Legacy CSV output generation
   */
  private generateCsvOutput(
    scanResult: ScanResult,
    options: ExportOptions,
    deduplicateSignatures: boolean
  ): string {
    return this.generateCategoryCsvOutput(scanResult, options, 'contracts', deduplicateSignatures);
  }

  /**
   * Legacy Markdown output generation
   */
  private generateMarkdownOutput(
    scanResult: ScanResult,
    options: ExportOptions,
    deduplicateSignatures: boolean
  ): string {
    return this.generateCategoryMarkdownOutput(
      scanResult,
      options,
      'contracts',
      deduplicateSignatures
    );
  }

  /**
   * Prepend update information to content
   */
  private prependUpdateInfo(content: string, format: string): string {
    const timestamp = new Date().toISOString();

    switch (format) {
      case 'txt':
      case 'md':
        return `# Updated: ${timestamp}\n# Previous content replaced\n\n${content}`;
      case 'json': {
        // Inject fields into metadata without parse/re-stringify to avoid doubling memory
        const injection = `"lastUpdated": ${JSON.stringify(timestamp)},\n    "note": "Previous content replaced",\n    `;
        return content.replace('"metadata": {\n    ', `"metadata": {\n    ${injection}`);
      }
      case 'csv':
        return `# Updated: ${timestamp}\n# Previous content replaced\n${content}`;
      default:
        return content;
    }
  }

  /**
   * Update .gitignore to include signatures directory
   */
  private async updateGitignore(rootPath: string, signaturesDir: string): Promise<void> {
    const gitignorePath = path.join(rootPath, '.gitignore');
    const relativePath = path.relative(rootPath, signaturesDir);
    const gitignoreEntry = `\n# 0xTools generated signatures\n${relativePath}/\n`;

    try {
      let gitignoreContent = '';
      if (fs.existsSync(gitignorePath)) {
        gitignoreContent = fs.readFileSync(gitignorePath, 'utf-8');
      }

      // Check if signatures directory is already in gitignore
      if (
        !gitignoreContent.includes(relativePath + '/') &&
        !gitignoreContent.includes('signatures/')
      ) {
        fs.appendFileSync(gitignorePath, gitignoreEntry);
      }
    } catch (error) {
      // Ignore errors - .gitignore update is not critical
      console.warn('Warning: Could not update .gitignore:', error);
    }
  }

  /**
   * Filter functions based on options
   */
  private filterFunctions(
    functions: FunctionSignature[],
    options: ExportOptions
  ): FunctionSignature[] {
    return functions.filter((func) =>
      shouldIncludeFunction(func.visibility, options.includeInternal, options.includePrivate)
    );
  }
}
