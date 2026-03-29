/**
 * Tests for Selector Collision Detector
 */

import { CollisionDetector } from '../collision-detector';
import { ContractInfo, FunctionSignature } from '../../types';

function makeFn(
  name: string,
  signature: string,
  selector: string,
  contractName: string,
  filePath: string,
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
    contractName,
    filePath,
  };
}

function makeContract(
  name: string,
  filePath: string,
  functions: FunctionSignature[]
): ContractInfo {
  return {
    name,
    filePath,
    functions,
    events: [],
    errors: [],
    lastModified: new Date(),
    category: 'contracts',
  };
}

describe('CollisionDetector', () => {
  let detector: CollisionDetector;

  beforeEach(() => {
    detector = new CollisionDetector();
  });

  describe('detectCollisions', () => {
    it('should return empty array when no contracts provided', () => {
      const contracts = new Map<string, ContractInfo>();
      const collisions = detector.detectCollisions(contracts);
      expect(collisions).toEqual([]);
    });

    it('should return empty array when no collisions exist', () => {
      const contracts = new Map<string, ContractInfo>();
      contracts.set(
        '/path/A.sol',
        makeContract('A', '/path/A.sol', [
          makeFn('transfer', 'transfer(address,uint256)', '0xa9059cbb', 'A', '/path/A.sol'),
          makeFn('approve', 'approve(address,uint256)', '0x095ea7b3', 'A', '/path/A.sol'),
        ])
      );
      const collisions = detector.detectCollisions(contracts);
      expect(collisions).toEqual([]);
    });

    it('should detect collisions between different signatures with same selector', () => {
      const contracts = new Map<string, ContractInfo>();
      // Two different signatures that happen to produce the same selector
      contracts.set(
        '/path/A.sol',
        makeContract('A', '/path/A.sol', [
          makeFn('funcA', 'funcA(uint256)', '0xdeadbeef', 'A', '/path/A.sol'),
        ])
      );
      contracts.set(
        '/path/B.sol',
        makeContract('B', '/path/B.sol', [
          makeFn('funcB', 'funcB(address)', '0xdeadbeef', 'B', '/path/B.sol'),
        ])
      );

      const collisions = detector.detectCollisions(contracts);
      expect(collisions.length).toBe(1);
      expect(collisions[0].selector).toBe('0xdeadbeef');
      expect(collisions[0].functions.length).toBe(2);
    });

    it('should NOT flag same signature appearing in interface and implementation', () => {
      const contracts = new Map<string, ContractInfo>();
      contracts.set(
        '/path/IERC20.sol',
        makeContract('IERC20', '/path/IERC20.sol', [
          makeFn(
            'transfer',
            'transfer(address,uint256)',
            '0xa9059cbb',
            'IERC20',
            '/path/IERC20.sol',
            'external'
          ),
        ])
      );
      contracts.set(
        '/path/Token.sol',
        makeContract('Token', '/path/Token.sol', [
          makeFn('transfer', 'transfer(address,uint256)', '0xa9059cbb', 'Token', '/path/Token.sol'),
        ])
      );

      const collisions = detector.detectCollisions(contracts);
      // Same signature in both => same uniqueSignature set => no collision
      expect(collisions).toEqual([]);
    });

    it('should skip internal and private functions', () => {
      const contracts = new Map<string, ContractInfo>();
      contracts.set(
        '/path/A.sol',
        makeContract('A', '/path/A.sol', [
          makeFn('_internal', '_internal()', '0xdeadbeef', 'A', '/path/A.sol', 'internal'),
        ])
      );
      contracts.set(
        '/path/B.sol',
        makeContract('B', '/path/B.sol', [
          makeFn('funcB', 'funcB()', '0xdeadbeef', 'B', '/path/B.sol'),
        ])
      );

      const collisions = detector.detectCollisions(contracts);
      // Internal function is skipped, so no collision
      expect(collisions).toEqual([]);
    });

    it('should skip constructors', () => {
      const contracts = new Map<string, ContractInfo>();
      contracts.set(
        '/path/A.sol',
        makeContract('A', '/path/A.sol', [
          makeFn('constructor', 'constructor()', '0xdeadbeef', 'A', '/path/A.sol'),
        ])
      );
      contracts.set(
        '/path/B.sol',
        makeContract('B', '/path/B.sol', [
          makeFn('funcB', 'funcB()', '0xdeadbeef', 'B', '/path/B.sol'),
        ])
      );

      const collisions = detector.detectCollisions(contracts);
      expect(collisions).toEqual([]);
    });

    it('should handle case-insensitive selector comparison', () => {
      const contracts = new Map<string, ContractInfo>();
      contracts.set(
        '/path/A.sol',
        makeContract('A', '/path/A.sol', [
          makeFn('funcA', 'funcA()', '0xDEADBEEF', 'A', '/path/A.sol'),
        ])
      );
      contracts.set(
        '/path/B.sol',
        makeContract('B', '/path/B.sol', [
          makeFn('funcB', 'funcB()', '0xdeadbeef', 'B', '/path/B.sol'),
        ])
      );

      const collisions = detector.detectCollisions(contracts);
      expect(collisions.length).toBe(1);
    });

    it('should sort collisions by selector', () => {
      const contracts = new Map<string, ContractInfo>();
      contracts.set(
        '/path/A.sol',
        makeContract('A', '/path/A.sol', [
          makeFn('funcA', 'funcA()', '0xffffffff', 'A', '/path/A.sol'),
          makeFn('funcC', 'funcC()', '0x00000001', 'A', '/path/A.sol'),
        ])
      );
      contracts.set(
        '/path/B.sol',
        makeContract('B', '/path/B.sol', [
          makeFn('funcB', 'funcB()', '0xffffffff', 'B', '/path/B.sol'),
          makeFn('funcD', 'funcD()', '0x00000001', 'B', '/path/B.sol'),
        ])
      );

      const collisions = detector.detectCollisions(contracts);
      expect(collisions.length).toBe(2);
      expect(collisions[0].selector).toBe('0x00000001');
      expect(collisions[1].selector).toBe('0xffffffff');
    });
  });

  describe('detectIntraContractCollisions', () => {
    it('should return empty array for single function', () => {
      const contract = makeContract('A', '/path/A.sol', [
        makeFn('funcA', 'funcA()', '0x12345678', 'A', '/path/A.sol'),
      ]);

      const collisions = detector.detectIntraContractCollisions(contract);
      expect(collisions).toEqual([]);
    });

    it('should detect duplicate selectors within a single contract', () => {
      const contract = makeContract('A', '/path/A.sol', [
        makeFn('funcA', 'funcA()', '0xdeadbeef', 'A', '/path/A.sol'),
        makeFn('funcB', 'funcB(uint256)', '0xdeadbeef', 'A', '/path/A.sol'),
      ]);

      const collisions = detector.detectIntraContractCollisions(contract);
      expect(collisions.length).toBe(1);
      expect(collisions[0].functions.length).toBe(2);
    });

    it('should skip private functions within a contract', () => {
      const contract = makeContract('A', '/path/A.sol', [
        makeFn('_private', '_private()', '0xdeadbeef', 'A', '/path/A.sol', 'private'),
        makeFn('funcB', 'funcB()', '0xdeadbeef', 'A', '/path/A.sol'),
      ]);

      const collisions = detector.detectIntraContractCollisions(contract);
      expect(collisions).toEqual([]);
    });
  });

  describe('generateReport', () => {
    it('should generate empty collision report', () => {
      const report = detector.generateReport([]);
      expect(report).toContain('Selector Collision Report');
      expect(report).toContain('No selector collisions detected');
    });

    it('should generate report with collision details', () => {
      const collisions = [
        {
          selector: '0xdeadbeef',
          functions: [
            {
              name: 'funcA',
              signature: 'funcA(uint256)',
              contractName: 'A',
              filePath: '/path/A.sol',
            },
            {
              name: 'funcB',
              signature: 'funcB(address)',
              contractName: 'B',
              filePath: '/path/B.sol',
            },
          ],
        },
      ];

      const report = detector.generateReport(collisions);
      expect(report).toContain('Selector Collision Report');
      expect(report).toContain('1 collision(s) detected');
      expect(report).toContain('0xdeadbeef');
      expect(report).toContain('funcA');
      expect(report).toContain('funcB');
      expect(report).toContain('proxy');
    });

    it('should include table headers in the report', () => {
      const collisions = [
        {
          selector: '0x12345678',
          functions: [
            { name: 'a', signature: 'a()', contractName: 'X', filePath: '/x.sol' },
            { name: 'b', signature: 'b()', contractName: 'Y', filePath: '/y.sol' },
          ],
        },
      ];

      const report = detector.generateReport(collisions);
      expect(report).toContain('Function');
      expect(report).toContain('Signature');
      expect(report).toContain('Contract');
      expect(report).toContain('File');
    });
  });
});
