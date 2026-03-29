import * as fs from 'fs';
import * as path from 'path';
import { glob } from 'glob';
import { ProjectInfo, ContractInfo, ScanResult, ContractCategory } from '../types';
import { SolidityParser } from './parser';

// Pre-compiled regex for import extraction — hoisted to avoid per-call allocation
const IMPORT_RE = /import\s+[^"]*"([^"]+)"/g;

export interface SubProject {
  path: string;
  type: 'foundry' | 'hardhat' | 'solidity';
  scanResult?: ScanResult;
}

export class ProjectScanner {
  private parser: SolidityParser;

  constructor() {
    this.parser = new SolidityParser();
  }

  /**
   * Find all subprojects recursively within a root directory
   */
  public async findAllSubProjects(rootPath: string): Promise<SubProject[]> {
    const subProjects: SubProject[] = [];
    const visited = new Set<string>();

    await this.findSubProjectsRecursive(rootPath, subProjects, visited);

    // If no subprojects found, treat root as a single project
    if (subProjects.length === 0) {
      const hasAnysolFiles = await this.hasSolidityFiles(rootPath);
      if (hasAnysolFiles) {
        subProjects.push({
          path: rootPath,
          type: 'solidity',
        });
      }
    }

    return subProjects;
  }

  /**
   * Recursively find subprojects
   */
  private async findSubProjectsRecursive(
    dirPath: string,
    subProjects: SubProject[],
    visited: Set<string>
  ): Promise<void> {
    const realPath = fs.realpathSync(dirPath);
    if (visited.has(realPath)) {
      return;
    }
    visited.add(realPath);

    // Skip common non-project directories
    const basename = path.basename(dirPath);
    const skipDirs = [
      'node_modules',
      '.git',
      'cache',
      'out',
      'artifacts',
      'typechain-types',
      'broadcast',
      '.deps',
    ];
    if (skipDirs.includes(basename)) {
      return;
    }

    // Check if this directory is a project root
    const foundryConfig = path.join(dirPath, 'foundry.toml');
    const hardhatConfigJs = path.join(dirPath, 'hardhat.config.js');
    const hardhatConfigTs = path.join(dirPath, 'hardhat.config.ts');

    const isFoundry = fs.existsSync(foundryConfig);
    const isHardhat = fs.existsSync(hardhatConfigJs) || fs.existsSync(hardhatConfigTs);

    if (isFoundry || isHardhat) {
      subProjects.push({
        path: dirPath,
        type: isFoundry ? 'foundry' : 'hardhat',
      });
      // Don't recurse into project subdirectories for subprojects
      // The project will scan its own contract dirs
      return;
    }

    // Recurse into subdirectories
    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const subDir = path.join(dirPath, entry.name);
          await this.findSubProjectsRecursive(subDir, subProjects, visited);
        }
      }
    } catch {
      // Ignore permission errors
    }
  }

  /**
   * Check if directory contains any .sol files
   */
  private async hasSolidityFiles(dirPath: string): Promise<boolean> {
    const files = await this.findSolidityFiles(dirPath);
    return files.length > 0;
  }

  /**
   * Scan all subprojects and return combined results with per-project exports
   */
  public async scanAllSubProjects(rootPath: string): Promise<{
    subProjects: SubProject[];
    combinedResult: ScanResult;
  }> {
    const subProjects = await this.findAllSubProjects(rootPath);

    // Scan each subproject
    for (const subProject of subProjects) {
      subProject.scanResult = await this.scanProject(subProject.path);
    }

    // Create combined result for backwards compatibility
    const combinedContracts = new Map<string, ContractInfo>();
    const combinedByCategory = new Map<ContractCategory, ContractInfo[]>();
    const combinedUniqueSignatures = new Map<string, any>();

    combinedByCategory.set('contracts', []);
    combinedByCategory.set('libs', []);
    combinedByCategory.set('tests', []);

    let totalFunctions = 0;
    let totalEvents = 0;
    let totalErrors = 0;

    for (const subProject of subProjects) {
      if (subProject.scanResult) {
        // Merge contracts
        for (const [filePath, contract] of subProject.scanResult.projectInfo.contracts) {
          combinedContracts.set(filePath, contract);
        }

        // Merge by category
        for (const category of ['contracts', 'libs', 'tests'] as ContractCategory[]) {
          const existing = combinedByCategory.get(category) || [];
          const newContracts = subProject.scanResult.contractsByCategory.get(category) || [];
          combinedByCategory.set(category, [...existing, ...newContracts]);
        }

        // Merge unique signatures
        for (const [sig, info] of subProject.scanResult.uniqueSignatures) {
          combinedUniqueSignatures.set(sig, info);
        }

        totalFunctions += subProject.scanResult.totalFunctions;
        totalEvents += subProject.scanResult.totalEvents;
        totalErrors += subProject.scanResult.totalErrors;
      }
    }

    const combinedResult: ScanResult = {
      projectInfo: {
        type: 'unknown',
        rootPath,
        contractDirs: [],
        contracts: combinedContracts,
        inheritedContracts: new Set(),
      },
      totalContracts: combinedContracts.size,
      totalFunctions,
      totalEvents,
      totalErrors,
      scanTime: new Date(),
      contractsByCategory: combinedByCategory,
      uniqueSignatures: combinedUniqueSignatures,
    };

    return { subProjects, combinedResult };
  }

  /**
   * Detect project type and scan for contracts
   */
  public async scanProject(rootPath: string): Promise<ScanResult> {
    const projectInfo = this.detectProjectType(rootPath);
    const contracts = new Map<string, ContractInfo>();
    const contractsByCategory = new Map<ContractCategory, ContractInfo[]>();
    const uniqueSignatures = new Map<string, any>();

    // Initialize category maps
    contractsByCategory.set('contracts', []);
    contractsByCategory.set('libs', []);
    contractsByCategory.set('tests', []);

    // Scan all contract directories
    for (const contractDir of projectInfo.contractDirs) {
      const fullPath = path.join(rootPath, contractDir);
      if (fs.existsSync(fullPath)) {
        const contractFiles = await this.findSolidityFiles(fullPath);

        for (const filePath of contractFiles) {
          const contractInfo = this.parser.parseFile(filePath);
          if (contractInfo) {
            // Categorize the contract
            contractInfo.category = this.categorizeContract(filePath, rootPath);
            contracts.set(filePath, contractInfo);

            // Add to category map
            const categoryContracts = contractsByCategory.get(contractInfo.category) || [];
            categoryContracts.push(contractInfo);
            contractsByCategory.set(contractInfo.category, categoryContracts);
          }
        }
      }
    }

    // Read each 'contracts'-category file once and use it for both
    // inherited contract detection and import checking
    const contractFileContents = new Map<string, string>();
    for (const [filePath, contract] of contracts) {
      if (contract.category === 'contracts') {
        try {
          contractFileContents.set(filePath, fs.readFileSync(filePath, 'utf-8'));
        } catch {
          // skip unreadable files
        }
      }
    }

    // Detect inherited contracts from libs (single pass over cached content)
    this.detectInheritedContracts(contractFileContents, projectInfo);

    // Filter lib contracts to only include inherited ones
    const libContracts = contractsByCategory.get('libs') || [];
    const filteredLibContracts = libContracts.filter((contract) => {
      return (
        projectInfo.inheritedContracts.has(contract.name) ||
        this.isContractImported(contract.name, contractFileContents)
      );
    });
    contractsByCategory.set('libs', filteredLibContracts);

    // Collect unique signatures to avoid duplicates
    this.collectUniqueSignatures(contracts, uniqueSignatures);

    projectInfo.contracts = contracts;

    // Calculate statistics
    let totalFunctions = 0;
    let totalEvents = 0;
    let totalErrors = 0;

    contracts.forEach((contract) => {
      totalFunctions += contract.functions.length;
      totalEvents += contract.events.length;
      totalErrors += contract.errors.length;
    });

    return {
      projectInfo,
      totalContracts: contracts.size,
      totalFunctions,
      totalEvents,
      totalErrors,
      scanTime: new Date(),
      contractsByCategory,
      uniqueSignatures,
    };
  }

  /**
   * Categorize contract based on file path
   */
  private categorizeContract(filePath: string, rootPath: string): ContractCategory {
    const relativePath = path.relative(rootPath, filePath);

    if (relativePath.includes('test') || relativePath.includes('Test')) {
      return 'tests';
    }
    if (relativePath.includes('lib/') || relativePath.includes('libs/')) {
      return 'libs';
    }
    return 'contracts';
  }

  /**
   * Detect inherited contracts by parsing import statements.
   * Uses pre-read file contents to avoid redundant disk reads.
   */
  private detectInheritedContracts(
    contractFileContents: Map<string, string>,
    projectInfo: ProjectInfo
  ): void {
    projectInfo.inheritedContracts = new Set<string>();

    for (const [, content] of contractFileContents) {
      const imports = this.extractImports(content);

      for (const importPath of imports) {
        if (importPath.includes('lib/')) {
          const contractName = this.extractContractNameFromImport(importPath);
          if (contractName) {
            projectInfo.inheritedContracts.add(contractName);
          }
        }
      }
    }
  }

  /**
   * Extract import statements from Solidity content
   */
  private extractImports(content: string): string[] {
    const imports: string[] = [];
    IMPORT_RE.lastIndex = 0;
    let match;

    while ((match = IMPORT_RE.exec(content)) !== null) {
      imports.push(match[1]);
    }

    return imports;
  }

  /**
   * Extract contract name from import path
   */
  private extractContractNameFromImport(importPath: string): string | null {
    const basename = path.basename(importPath, '.sol');
    return basename || null;
  }

  /**
   * Collect unique signatures to avoid duplicates
   */
  private collectUniqueSignatures(
    contracts: Map<string, ContractInfo>,
    uniqueSignatures: Map<string, any>
  ): void {
    for (const [, contract] of contracts) {
      // Collect unique function signatures
      for (const func of contract.functions) {
        uniqueSignatures.set(func.signature, func);
      }

      // Collect unique event signatures
      for (const event of contract.events) {
        uniqueSignatures.set(event.signature, event);
      }

      // Collect unique error signatures
      for (const error of contract.errors) {
        uniqueSignatures.set(error.signature, error);
      }
    }
  }

  /**
   * Detect if project is Foundry, Hardhat, or unknown
   */
  private detectProjectType(rootPath: string): ProjectInfo {
    const foundryConfig = path.join(rootPath, 'foundry.toml');
    const hardhatConfigJs = path.join(rootPath, 'hardhat.config.js');
    const hardhatConfigTs = path.join(rootPath, 'hardhat.config.ts');

    let type: 'foundry' | 'hardhat' | 'unknown' = 'unknown';
    let contractDirs: string[] = [];

    // Check for Foundry project
    const isFoundry = fs.existsSync(foundryConfig);
    // Check for Hardhat project
    const isHardhat = fs.existsSync(hardhatConfigJs) || fs.existsSync(hardhatConfigTs);

    if (isFoundry && isHardhat) {
      // Hybrid project - check both Foundry and Hardhat directories
      type = 'foundry';
      contractDirs = ['src', 'lib', 'contracts'];
    } else if (isFoundry) {
      type = 'foundry';
      // Also check for 'contracts' dir in case project uses non-standard Foundry layout
      contractDirs = fs.existsSync(path.join(rootPath, 'contracts'))
        ? ['src', 'lib', 'contracts']
        : ['src', 'lib'];
    } else if (isHardhat) {
      type = 'hardhat';
      contractDirs = ['contracts'];
    } else {
      // Default fallback - scan all common directories
      contractDirs = ['src', 'contracts'];
    }

    return {
      type,
      rootPath,
      contractDirs,
      contracts: new Map(),
      inheritedContracts: new Set(),
    };
  }

  /**
   * Find all Solidity files in a directory
   */
  private async findSolidityFiles(dirPath: string): Promise<string[]> {
    const pattern = path.join(dirPath, '**/*.sol');
    return new Promise((resolve, reject) => {
      glob(pattern, (err, files) => {
        if (err) {
          reject(err);
        } else {
          resolve(files);
        }
      });
    });
  }

  /**
   * Check if a file has been modified since last scan
   */
  public hasFileChanged(filePath: string, lastModified: Date): boolean {
    try {
      const stats = fs.statSync(filePath);
      return stats.mtime > lastModified;
    } catch {
      return true; // File doesn't exist or error, consider it changed
    }
  }

  /**
   * Scan only changed files
   */
  public async scanChangedFiles(
    projectInfo: ProjectInfo,
    lastScanTime: Date
  ): Promise<{ changed: ContractInfo[]; removed: string[] }> {
    const changed: ContractInfo[] = [];
    const removed: string[] = [];

    // Check existing contracts for changes
    for (const [filePath] of projectInfo.contracts) {
      if (!fs.existsSync(filePath)) {
        removed.push(filePath);
        continue;
      }

      if (this.hasFileChanged(filePath, lastScanTime)) {
        const updatedContract = this.parser.parseFile(filePath);
        if (updatedContract) {
          changed.push(updatedContract);
          projectInfo.contracts.set(filePath, updatedContract);
        }
      }
    }

    // Check for new files
    for (const contractDir of projectInfo.contractDirs) {
      const fullPath = path.join(projectInfo.rootPath, contractDir);
      if (fs.existsSync(fullPath)) {
        const contractFiles = await this.findSolidityFiles(fullPath);

        for (const filePath of contractFiles) {
          if (!projectInfo.contracts.has(filePath)) {
            const newContract = this.parser.parseFile(filePath);
            if (newContract) {
              changed.push(newContract);
              projectInfo.contracts.set(filePath, newContract);
            }
          }
        }
      }
    }

    // Remove deleted files from project
    removed.forEach((filePath) => {
      projectInfo.contracts.delete(filePath);
    });

    return { changed, removed };
  }

  /**
   * Check if a contract is imported by any main contracts.
   * Uses pre-read file contents to avoid redundant disk reads.
   */
  private isContractImported(
    contractName: string,
    contractFileContents: Map<string, string>
  ): boolean {
    // Build inheritance regex once per call (not per file iteration)
    const inheritancePattern = new RegExp(`contract\\s+\\w+\\s+is\\s+.*${contractName}`, 'i');

    for (const [, content] of contractFileContents) {
      // Check if this contract imports the given contract name
      if (content.includes(`import`) && content.includes(contractName)) {
        return true;
      }
      // Also check inheritance patterns
      if (inheritancePattern.test(content)) {
        return true;
      }
    }
    return false;
  }
}
