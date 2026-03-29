/**
 * Tests for Event Emission Checker
 */

import { EventEmissionChecker } from '../event-checker';

describe('EventEmissionChecker', () => {
  let checker: EventEmissionChecker;

  beforeEach(() => {
    checker = new EventEmissionChecker();
  });

  describe('detect - empty/trivial input', () => {
    it('should return empty array for empty source', () => {
      const warnings = checker.detect('');
      expect(warnings).toEqual([]);
    });

    it('should return empty array for contract with only view/pure functions', () => {
      const source = `
pragma solidity ^0.8.0;
contract ReadOnly {
    uint256 public value;

    function getValue() public view returns (uint256) {
        return value;
    }

    function compute(uint256 a, uint256 b) public pure returns (uint256) {
        return a + b;
    }
}
`;
      const warnings = checker.detect(source);
      expect(warnings).toEqual([]);
    });
  });

  describe('detect - missing events', () => {
    it('should detect state-changing function without emit', () => {
      const source = `pragma solidity ^0.8.0;
contract Test {
    mapping(address => uint256) balances;
    function deposit(uint256 amount) public {
        balances[msg.sender] = amount;
    }
}
`;
      const warnings = checker.detect(source);
      expect(warnings.length).toBe(1);
      expect(warnings[0].functionName).toBe('deposit');
      expect(warnings[0].stateChanges.length).toBeGreaterThan(0);
    });

    it('should detect missing event in function with ETH transfer', () => {
      const source = `
pragma solidity ^0.8.0;
contract Test {
    mapping(address => uint256) balances;

    function withdraw(uint256 amount) public {
        balances[msg.sender] -= amount;
        payable(msg.sender).transfer(amount);
    }
}
`;
      const warnings = checker.detect(source);
      expect(warnings.length).toBeGreaterThan(0);
      expect(warnings[0].functionName).toBe('withdraw');
    });

    it('should detect missing event in function with delete statement', () => {
      const source = `pragma solidity ^0.8.0;
contract Test {
    mapping(address => uint256) data;
    function reset() public {
        delete data;
    }
}
`;
      const warnings = checker.detect(source);
      expect(warnings.length).toBe(1);
      expect(warnings[0].functionName).toBe('reset');
      expect(warnings[0].stateChanges).toContain('delete');
    });

    it('should detect missing event in function with delete', () => {
      const source = `
pragma solidity ^0.8.0;
contract Test {
    mapping(address => uint256) data;

    function reset(address user) public {
        delete data[user];
    }
}
`;
      const warnings = checker.detect(source);
      // delete should be detected as a state change
      expect(warnings.length).toBe(1);
      expect(warnings[0].stateChanges).toContain('delete');
    });
  });

  describe('detect - functions with events (no false positives)', () => {
    it('should NOT flag function that emits an event', () => {
      const source = `
pragma solidity ^0.8.0;
contract Test {
    event Deposited(address indexed user, uint256 amount);
    mapping(address => uint256) balances;

    function deposit() public {
        balances[msg.sender] += msg.value;
        emit Deposited(msg.sender, msg.value);
    }
}
`;
      const warnings = checker.detect(source);
      expect(warnings).toEqual([]);
    });

    it('should NOT flag internal/private functions', () => {
      const source = `
pragma solidity ^0.8.0;
contract Test {
    mapping(address => uint256) balances;

    function _update(address user, uint256 amount) internal {
        balances[user] += amount;
    }
}
`;
      const warnings = checker.detect(source);
      expect(warnings).toEqual([]);
    });

    it('should NOT flag constructor', () => {
      const source = `
pragma solidity ^0.8.0;
contract Test {
    uint256 value;
    constructor(uint256 _value) {
        value = _value;
    }
}
`;
      const warnings = checker.detect(source);
      expect(warnings).toEqual([]);
    });
  });

  describe('detect - local variables not counted as state changes', () => {
    it('should NOT flag local variable assignments as state changes', () => {
      const source = `
pragma solidity ^0.8.0;
contract Test {
    function compute(uint256 x) public pure returns (uint256) {
        uint256 result = x * 2;
        return result;
    }
}
`;
      const warnings = checker.detect(source);
      expect(warnings).toEqual([]);
    });

    it('should NOT flag memory variable assignments', () => {
      const source = `
pragma solidity ^0.8.0;
contract Test {
    function process(bytes memory data) public pure returns (uint256) {
        bytes memory result = data;
        return result.length;
    }
}
`;
      const warnings = checker.detect(source);
      expect(warnings).toEqual([]);
    });
  });

  describe('detect - multiple functions', () => {
    it('should report each function missing events separately', () => {
      const source = `pragma solidity ^0.8.0;
contract Test {
    mapping(address => uint256) balances;
    uint256 counter;
    function deposit(uint256 amount) public {
        balances[msg.sender] = amount;
    }
    function increment() public {
        delete counter;
    }
    function safe(uint256 amount) public {
        balances[msg.sender] = amount;
        emit Deposited(msg.sender, amount);
    }
}
`;
      const warnings = checker.detect(source);
      expect(warnings.length).toBe(2);
      const functionNames = warnings.map((w) => w.functionName);
      expect(functionNames).toContain('deposit');
      expect(functionNames).toContain('increment');
      expect(functionNames).not.toContain('safe');
    });
  });

  describe('detect - comment handling', () => {
    it('should skip commented-out state changes', () => {
      const source = `
pragma solidity ^0.8.0;
contract Test {
    uint256 value;

    function test() public {
        // value += 1;
    }
}
`;
      const warnings = checker.detect(source);
      expect(warnings).toEqual([]);
    });
  });

  describe('generateReport', () => {
    it('should generate report with no warnings', () => {
      const report = checker.generateReport([]);
      expect(report).toContain('Missing Event Emission Report');
      expect(report).toContain('All state-changing functions emit events');
    });

    it('should generate report with warnings', () => {
      const warnings = [
        {
          line: 5,
          functionName: 'deposit',
          description: 'State-changing function does not emit any events.',
          stateChanges: ['mapping/array write', 'compound assignment'],
        },
      ];

      const report = checker.generateReport(warnings);
      expect(report).toContain('**1** function(s) missing event emissions');
      expect(report).toContain('deposit');
      expect(report).toContain('mapping/array write');
      expect(report).toContain('compound assignment');
    });
  });
});
