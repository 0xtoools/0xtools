/**
 * Tests for ERC Interface Compliance Checker
 */

import { InterfaceChecker, KNOWN_INTERFACES } from '../interface-check';
import { ContractInfo, FunctionSignature, InterfaceDefinition } from '../../types';

function makeFn(
  name: string,
  signature: string,
  selector: string,
  visibility: 'public' | 'external' | 'internal' | 'private' = 'public'
): FunctionSignature {
  return {
    name,
    signature,
    selector,
    visibility,
    stateMutability: 'nonpayable',
    inputs: [],
    outputs: [],
    contractName: 'TestContract',
    filePath: '/test.sol',
  };
}

function makeContract(functions: FunctionSignature[]): ContractInfo {
  return {
    name: 'TestContract',
    filePath: '/test.sol',
    functions,
    events: [],
    errors: [],
    lastModified: new Date(),
    category: 'contracts',
  };
}

describe('InterfaceChecker', () => {
  let checker: InterfaceChecker;

  beforeEach(() => {
    checker = new InterfaceChecker();
  });

  describe('Constructor', () => {
    it('should initialize with known interfaces', () => {
      const interfaces = checker.getRegisteredInterfaces();
      expect(interfaces.length).toBeGreaterThanOrEqual(4); // ERC20, ERC721, ERC1155, ERC4626
    });

    it('should accept additional interfaces', () => {
      const custom: InterfaceDefinition = {
        name: 'CustomInterface',
        selectors: { 'customFunc()': '0x11111111' },
      };
      const checkerWithCustom = new InterfaceChecker([custom]);
      const interfaces = checkerWithCustom.getRegisteredInterfaces();
      expect(interfaces.some((i) => i.name === 'CustomInterface')).toBe(true);
    });
  });

  describe('checkCompliance - ERC20', () => {
    it('should detect full ERC20 compliance', () => {
      const erc20 = KNOWN_INTERFACES.find((i) => i.name === 'ERC20')!;
      const functions = Object.entries(erc20.selectors).map(([sig, sel]) => {
        const name = sig.substring(0, sig.indexOf('('));
        return makeFn(name, sig, sel);
      });

      const contract = makeContract(functions);
      const results = checker.checkCompliance(contract);

      const erc20Result = results.find((r) => r.interfaceName === 'ERC20');
      expect(erc20Result).toBeDefined();
      expect(erc20Result!.compliant).toBe(true);
      expect(erc20Result!.missing.length).toBe(0);
    });

    it('should detect partial ERC20 compliance', () => {
      // Only implement transfer and balanceOf
      const functions = [
        makeFn('transfer', 'transfer(address,uint256)', '0xa9059cbb'),
        makeFn('balanceOf', 'balanceOf(address)', '0x70a08231'),
      ];

      const contract = makeContract(functions);
      const results = checker.checkCompliance(contract);

      const erc20Result = results.find((r) => r.interfaceName === 'ERC20');
      expect(erc20Result).toBeDefined();
      expect(erc20Result!.compliant).toBe(false);
      expect(erc20Result!.implemented.length).toBe(2);
      expect(erc20Result!.missing.length).toBeGreaterThan(0);
    });

    it('should report missing ERC20 functions', () => {
      // Implement everything except totalSupply
      const erc20 = KNOWN_INTERFACES.find((i) => i.name === 'ERC20')!;
      const functions = Object.entries(erc20.selectors)
        .filter(([sig]) => sig !== 'totalSupply()')
        .map(([sig, sel]) => {
          const name = sig.substring(0, sig.indexOf('('));
          return makeFn(name, sig, sel);
        });

      const contract = makeContract(functions);
      const results = checker.checkCompliance(contract);

      const erc20Result = results.find((r) => r.interfaceName === 'ERC20');
      expect(erc20Result).toBeDefined();
      expect(erc20Result!.compliant).toBe(false);
      expect(erc20Result!.missing).toContain('totalSupply()');
    });
  });

  describe('checkCompliance - ERC721', () => {
    it('should detect ERC721 compliance', () => {
      const erc721 = KNOWN_INTERFACES.find((i) => i.name === 'ERC721')!;
      const functions = Object.entries(erc721.selectors).map(([sig, sel]) => {
        const name = sig.substring(0, sig.indexOf('('));
        return makeFn(name, sig, sel);
      });

      const contract = makeContract(functions);
      const results = checker.checkCompliance(contract);

      const erc721Result = results.find((r) => r.interfaceName === 'ERC721');
      expect(erc721Result).toBeDefined();
      expect(erc721Result!.compliant).toBe(true);
    });
  });

  describe('checkCompliance - Edge Cases', () => {
    it('should return empty results for a contract with no matching selectors', () => {
      const functions = [makeFn('customFunc', 'customFunc()', '0x99999999')];
      const contract = makeContract(functions);
      const results = checker.checkCompliance(contract);
      expect(results.length).toBe(0);
    });

    it('should ignore internal/private functions', () => {
      const functions = [
        makeFn('transfer', 'transfer(address,uint256)', '0xa9059cbb', 'internal'),
        makeFn('balanceOf', 'balanceOf(address)', '0x70a08231', 'private'),
      ];
      const contract = makeContract(functions);
      const results = checker.checkCompliance(contract);
      // Internal/private functions should not count toward compliance
      expect(results.length).toBe(0);
    });

    it('should handle contract with no functions', () => {
      const contract = makeContract([]);
      const results = checker.checkCompliance(contract);
      expect(results).toEqual([]);
    });

    it('should handle case-insensitive selector matching', () => {
      const functions = [makeFn('transfer', 'transfer(address,uint256)', '0xA9059CBB')];
      const contract = makeContract(functions);
      const results = checker.checkCompliance(contract);
      const erc20Result = results.find((r) => r.interfaceName === 'ERC20');
      expect(erc20Result).toBeDefined();
      expect(erc20Result!.implemented).toContain('transfer(address,uint256)');
    });
  });

  describe('checkAllContracts', () => {
    it('should check compliance for all contracts in a map', () => {
      const contracts = new Map<string, ContractInfo>();
      const erc20 = KNOWN_INTERFACES.find((i) => i.name === 'ERC20')!;
      const erc20Funcs = Object.entries(erc20.selectors).map(([sig, sel]) => {
        const name = sig.substring(0, sig.indexOf('('));
        return makeFn(name, sig, sel);
      });

      contracts.set('/Token.sol', {
        ...makeContract(erc20Funcs),
        name: 'Token',
      });
      contracts.set('/Other.sol', {
        ...makeContract([makeFn('custom', 'custom()', '0x99999999')]),
        name: 'Other',
      });

      const results = checker.checkAllContracts(contracts);
      expect(results.has('Token')).toBe(true);
      expect(results.has('Other')).toBe(false); // No matching interfaces
    });

    it('should handle empty contracts map', () => {
      const contracts = new Map<string, ContractInfo>();
      const results = checker.checkAllContracts(contracts);
      expect(results.size).toBe(0);
    });
  });

  describe('registerInterface', () => {
    it('should register a new custom interface', () => {
      const custom: InterfaceDefinition = {
        name: 'ERC5192',
        selectors: { 'locked(uint256)': '0xb45a3c0e' },
      };
      checker.registerInterface(custom);
      const interfaces = checker.getRegisteredInterfaces();
      expect(interfaces.some((i) => i.name === 'ERC5192')).toBe(true);
    });

    it('should replace existing interface with same name', () => {
      const custom1: InterfaceDefinition = {
        name: 'Custom',
        selectors: { 'a()': '0x11111111' },
      };
      const custom2: InterfaceDefinition = {
        name: 'Custom',
        selectors: { 'b()': '0x22222222' },
      };
      checker.registerInterface(custom1);
      checker.registerInterface(custom2);

      const interfaces = checker.getRegisteredInterfaces();
      const custom = interfaces.find((i) => i.name === 'Custom');
      expect(custom).toBeDefined();
      expect(custom!.selectors).toHaveProperty('b()');
      expect(custom!.selectors).not.toHaveProperty('a()');
    });
  });

  describe('generateReport', () => {
    it('should generate report for no matches', () => {
      const report = checker.generateReport('TestContract', []);
      expect(report).toContain('Interface Compliance: TestContract');
      expect(report).toContain('No known ERC interface patterns detected');
    });

    it('should generate report for compliant contract', () => {
      const results = [
        {
          interfaceName: 'ERC20',
          implemented: [
            'transfer(address,uint256)',
            'approve(address,uint256)',
            'transferFrom(address,address,uint256)',
            'balanceOf(address)',
            'allowance(address,address)',
            'totalSupply()',
          ],
          missing: [],
          compliant: true,
        },
      ];
      const report = checker.generateReport('Token', results);
      expect(report).toContain('[PASS]');
      expect(report).toContain('COMPLIANT');
      expect(report).toContain('100%');
      expect(report).toContain('ERC20');
    });

    it('should generate report for partially compliant contract', () => {
      const results = [
        {
          interfaceName: 'ERC20',
          implemented: ['transfer(address,uint256)'],
          missing: ['approve(address,uint256)', 'totalSupply()'],
          compliant: false,
        },
      ];
      const report = checker.generateReport('Token', results);
      expect(report).toContain('[WARN]');
      expect(report).toContain('PARTIAL');
      expect(report).toContain('Missing');
      expect(report).toContain('Implemented');
    });
  });
});
