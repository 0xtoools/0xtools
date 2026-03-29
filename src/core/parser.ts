import * as fs from 'fs';
import {
  FunctionSignature,
  EventSignature,
  ErrorSignature,
  ContractInfo,
  Parameter,
  NatspecInfo,
} from '../types';
import {
  generateFunctionSelector,
  generateEventSignature,
  normalizeFunctionSignature,
  getContractNameFromPath,
} from '../utils/helpers';

// Pre-compiled regexes — hoisted to module level to avoid per-call allocation
const CONTRACT_NAME_RE = /(contract|library|interface)\s+(\w+)/;
const FUNCTION_RE =
  /function\s+(\w+)\s*\((.*?)\)\s*(public|external|internal|private)?\s*(pure|view|payable|nonpayable)?\s*(?:returns\s*\((.*?)\))?\s*[{;]/gs;
const CONSTRUCTOR_RE = /constructor\s*\((.*?)\)\s*(public|internal)?\s*(payable)?\s*[{]/gs;
const MODIFIER_RE = /modifier\s+(\w+)\s*\((.*?)\)\s*[{]/gs;
const EVENT_RE = /event\s+(\w+)\s*\((.*?)\)\s*;/gs;
const ERROR_RE = /error\s+(\w+)\s*\((.*?)\)\s*;/gs;
const NATSPEC_TAG_RE = /@(\w+(?::\w+)?)\s+([^\n@]*(?:\n(?!\s*@)[^\n@]*)*)/g;

export class SolidityParser {
  /**
   * Parse a Solidity file and extract all signatures
   */
  public parseFile(filePath: string): ContractInfo | null {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      return this.parseContent(content, filePath);
    } catch (error) {
      console.error(`Error parsing file ${filePath}:`, error);
      return null;
    }
  }

  /**
   * Parse Solidity content directly (for real-time analysis without disk reads)
   */
  public parseContent(content: string, filePath: string): ContractInfo | null {
    try {
      const contractName = this.extractContractName(content) || getContractNameFromPath(filePath);

      const functions = this.extractFunctions(content, contractName, filePath);
      const events = this.extractEvents(content, contractName, filePath);
      const errors = this.extractErrors(content, contractName, filePath);

      return {
        name: contractName,
        filePath,
        functions,
        events,
        errors,
        lastModified: new Date(),
        category: 'contracts', // Default category, will be updated by scanner
      };
    } catch (error) {
      console.error(`Error parsing content for ${filePath}:`, error);
      return null;
    }
  }

  /**
   * Extract contract name from Solidity content
   */
  private extractContractName(content: string): string | null {
    const contractMatch = content.match(CONTRACT_NAME_RE);
    return contractMatch ? contractMatch[2] : null;
  }

  /**
   * Extract function signatures from Solidity content
   */
  private extractFunctions(
    content: string,
    contractName: string,
    filePath: string
  ): FunctionSignature[] {
    const functions: FunctionSignature[] = [];

    // Reset lastIndex for global regex reuse
    FUNCTION_RE.lastIndex = 0;

    let match;
    while ((match = FUNCTION_RE.exec(content)) !== null) {
      const [
        ,
        name,
        inputsStr,
        visibility = 'public',
        stateMutability = 'nonpayable',
        outputsStr = '',
      ] = match;

      const inputs = this.parseParameters(inputsStr);
      const outputs = this.parseParameters(outputsStr);

      const signature = normalizeFunctionSignature(name, inputs);
      const selector = generateFunctionSelector(signature);

      const natspec = this.extractNatspec(content, match.index);

      functions.push({
        name,
        signature,
        selector,
        visibility: visibility as 'public' | 'external' | 'internal' | 'private',
        stateMutability: stateMutability as 'pure' | 'view' | 'nonpayable' | 'payable',
        inputs,
        outputs,
        contractName,
        filePath,
        natspec,
      });
    }

    // Also extract constructor
    CONSTRUCTOR_RE.lastIndex = 0;
    const constructorMatch = CONSTRUCTOR_RE.exec(content);
    if (constructorMatch) {
      const [, inputsStr, visibility = 'public', payable] = constructorMatch;
      const inputs = this.parseParameters(inputsStr);
      const signature = normalizeFunctionSignature('constructor', inputs);
      const selector = generateFunctionSelector(signature);
      const natspec = this.extractNatspec(content, constructorMatch.index);

      functions.push({
        name: 'constructor',
        signature,
        selector,
        visibility: visibility as 'public' | 'internal',
        stateMutability: payable === 'payable' ? 'payable' : 'nonpayable',
        inputs,
        outputs: [],
        contractName,
        filePath,
        natspec,
      });
    }

    // Extract modifiers
    MODIFIER_RE.lastIndex = 0;
    let modifierMatch;
    while ((modifierMatch = MODIFIER_RE.exec(content)) !== null) {
      const [, name, inputsStr] = modifierMatch;
      const inputs = this.parseParameters(inputsStr);
      const signature = normalizeFunctionSignature(name, inputs);
      const selector = generateFunctionSelector(signature);

      functions.push({
        name: `modifier:${name}`,
        signature,
        selector,
        visibility: 'internal', // Modifiers are always internal
        stateMutability: 'nonpayable',
        inputs,
        outputs: [],
        contractName,
        filePath,
      });
    }

    return functions;
  }

  /**
   * Extract event signatures from Solidity content
   */
  private extractEvents(content: string, contractName: string, filePath: string): EventSignature[] {
    const events: EventSignature[] = [];

    EVENT_RE.lastIndex = 0;

    let match;
    while ((match = EVENT_RE.exec(content)) !== null) {
      const [, name, inputsStr] = match;
      const inputs = this.parseEventParameters(inputsStr);
      const signature = normalizeFunctionSignature(name, inputs);
      const selector = generateEventSignature(signature);

      const natspec = this.extractNatspec(content, match.index);

      events.push({
        name,
        signature,
        selector,
        inputs,
        contractName,
        filePath,
        natspec,
      });
    }

    return events;
  }

  /**
   * Extract error signatures from Solidity content
   */
  private extractErrors(content: string, contractName: string, filePath: string): ErrorSignature[] {
    const errors: ErrorSignature[] = [];

    ERROR_RE.lastIndex = 0;

    let match;
    while ((match = ERROR_RE.exec(content)) !== null) {
      const [, name, inputsStr] = match;
      const inputs = this.parseParameters(inputsStr);
      const signature = normalizeFunctionSignature(name, inputs);
      const selector = generateFunctionSelector(signature);

      const natspec = this.extractNatspec(content, match.index);

      errors.push({
        name,
        signature,
        selector,
        inputs,
        contractName,
        filePath,
        natspec,
      });
    }

    return errors;
  }

  /**
   * Parse function parameters
   */
  private parseParameters(paramString: string): Parameter[] {
    if (!paramString.trim()) {
      return [];
    }

    const params = paramString.split(',').map((p) => p.trim());
    return params
      .map((param) => {
        const parts = param.split(' ').filter((p) => p.length > 0);
        if (parts.length >= 2) {
          return {
            type: parts[0],
            name: parts[1],
          };
        }
        return {
          type: param,
          name: '',
        };
      })
      .filter((p) => p.type.length > 0);
  }

  /**
   * Parse event parameters (includes indexed keyword)
   */
  private parseEventParameters(paramString: string): Parameter[] {
    if (!paramString.trim()) {
      return [];
    }

    const params = paramString.split(',').map((p) => p.trim());
    return params
      .map((param) => {
        const parts = param.split(' ').filter((p) => p.length > 0);
        const indexed = parts.includes('indexed');

        if (indexed) {
          const typeIndex = parts.findIndex((p) => p !== 'indexed');
          const nameIndex = typeIndex + 1;

          return {
            type: parts[typeIndex] || '',
            name: parts[nameIndex] || '',
            indexed: true,
          };
        } else if (parts.length >= 2) {
          return {
            type: parts[0],
            name: parts[1],
            indexed: false,
          };
        }

        return {
          type: param,
          name: '',
          indexed: false,
        };
      })
      .filter((p) => p.type.length > 0);
  }

  /**
   * Extract NatSpec comment block immediately preceding a declaration.
   * Supports both /** ... * / block comments and /// line comments.
   */
  private extractNatspec(content: string, declarationIndex: number): NatspecInfo | undefined {
    // Look at content before the declaration
    const before = content.substring(0, declarationIndex).trimEnd();

    let commentBody: string | null = null;

    // Try block comment /** ... */
    const blockEnd = before.lastIndexOf('*/');
    if (blockEnd !== -1) {
      const blockStart = before.lastIndexOf('/**', blockEnd);
      if (blockStart !== -1) {
        // Verify nothing but whitespace between comment end and declaration
        const between = before.substring(blockEnd + 2).trim();
        if (between.length === 0) {
          commentBody = before
            .substring(blockStart + 3, blockEnd)
            .split('\n')
            .map((line) => line.replace(/^\s*\*\s?/, '').trim())
            .join('\n');
        }
      }
    }

    // Try /// line comments if no block comment found
    if (!commentBody) {
      const lines = before.split('\n');
      const commentLines: string[] = [];
      for (let i = lines.length - 1; i >= 0; i--) {
        const trimmed = lines[i].trim();
        if (trimmed.startsWith('///')) {
          commentLines.unshift(trimmed.substring(3).trim());
        } else if (trimmed.length === 0) {
          continue; // skip blank lines
        } else {
          break;
        }
      }
      if (commentLines.length > 0) {
        commentBody = commentLines.join('\n');
      }
    }

    if (!commentBody) {
      return undefined;
    }

    const info: NatspecInfo = {
      params: {},
      returns: {},
      custom: {},
    };

    // Parse tags
    NATSPEC_TAG_RE.lastIndex = 0;
    let tagMatch;

    // Collect text before first tag as @notice
    const firstTagIndex = commentBody.search(/@\w/);
    if (firstTagIndex > 0) {
      const preText = commentBody.substring(0, firstTagIndex).trim();
      if (preText) {
        info.notice = preText;
      }
    } else if (firstTagIndex === -1) {
      // No tags at all — entire comment is notice
      const trimmed = commentBody.trim();
      if (trimmed) {
        info.notice = trimmed;
      }
    }

    while ((tagMatch = NATSPEC_TAG_RE.exec(commentBody)) !== null) {
      const tag = tagMatch[1].toLowerCase();
      const value = tagMatch[2].trim();

      switch (tag) {
        case 'notice':
          info.notice = value;
          break;
        case 'dev':
          info.dev = value;
          break;
        case 'param': {
          const spaceIdx = value.indexOf(' ');
          if (spaceIdx !== -1) {
            info.params[value.substring(0, spaceIdx)] = value.substring(spaceIdx + 1).trim();
          }
          break;
        }
        case 'return':
        case 'returns': {
          const rSpaceIdx = value.indexOf(' ');
          if (rSpaceIdx !== -1) {
            info.returns[value.substring(0, rSpaceIdx)] = value.substring(rSpaceIdx + 1).trim();
          } else {
            info.returns[''] = value;
          }
          break;
        }
        default:
          info.custom[tag] = value;
          break;
      }
    }

    // Only return if we actually got something
    if (
      !info.notice &&
      !info.dev &&
      Object.keys(info.params).length === 0 &&
      Object.keys(info.returns).length === 0 &&
      Object.keys(info.custom).length === 0
    ) {
      return undefined;
    }

    return info;
  }
}
