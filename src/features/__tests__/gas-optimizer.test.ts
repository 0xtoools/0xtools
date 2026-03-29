/**
 * Tests for Gas Optimization Analyzer
 */

import { GasOptimizer } from '../gas-optimizer';

describe('GasOptimizer', () => {
  let optimizer: GasOptimizer;

  beforeEach(() => {
    optimizer = new GasOptimizer();
  });

  describe('analyze - empty/trivial input', () => {
    it('should return empty array for empty source', () => {
      const suggestions = optimizer.analyze('');
      expect(suggestions).toEqual([]);
    });

    it('should return empty array for source with only comments', () => {
      const source = `
// This is a comment
/* Multi-line comment */
/// NatSpec comment
`;
      const suggestions = optimizer.analyze(source);
      expect(suggestions).toEqual([]);
    });

    it('should return empty array for well-optimized contract', () => {
      const source = `
pragma solidity ^0.8.0;
contract Optimized {
    uint256 public constant MAX = 100;
    uint256 public immutable DEPLOYER_BLOCK;

    constructor() {
        DEPLOYER_BLOCK = block.number;
    }

    function add(uint256 a, uint256 b) external pure returns (uint256) {
        return a + b;
    }
}
`;
      const suggestions = optimizer.analyze(source);
      expect(suggestions).toEqual([]);
    });
  });

  describe('Rule: calldata-instead-of-memory', () => {
    it('should detect memory used in external function with array param', () => {
      const source = `
pragma solidity ^0.8.0;
contract Test {
    function processData(uint256[] memory data) external {
        // process
    }
}
`;
      const suggestions = optimizer.analyze(source);
      const calldataSuggestions = suggestions.filter(
        (s) => s.rule === 'calldata-instead-of-memory'
      );
      expect(calldataSuggestions.length).toBeGreaterThan(0);
      expect(calldataSuggestions[0].message).toContain('calldata');
    });

    it('should detect memory used with bytes parameter in external function', () => {
      const source = `
pragma solidity ^0.8.0;
contract Test {
    function process(bytes memory data) external {
        // process
    }
}
`;
      const suggestions = optimizer.analyze(source);
      const calldataSuggestions = suggestions.filter(
        (s) => s.rule === 'calldata-instead-of-memory'
      );
      expect(calldataSuggestions.length).toBeGreaterThan(0);
    });

    it('should detect memory used with string parameter in external function', () => {
      const source = `
pragma solidity ^0.8.0;
contract Test {
    function setName(string memory name) external {
        // set name
    }
}
`;
      const suggestions = optimizer.analyze(source);
      const calldataSuggestions = suggestions.filter(
        (s) => s.rule === 'calldata-instead-of-memory'
      );
      expect(calldataSuggestions.length).toBeGreaterThan(0);
    });

    it('should NOT flag public functions (they can be called internally too)', () => {
      const source = `
pragma solidity ^0.8.0;
contract Test {
    function process(uint256[] memory data) public {
        // can be called internally
    }
}
`;
      const suggestions = optimizer.analyze(source);
      const calldataSuggestions = suggestions.filter(
        (s) => s.rule === 'calldata-instead-of-memory'
      );
      expect(calldataSuggestions).toEqual([]);
    });
  });

  describe('Rule: immutable-candidate', () => {
    it('should detect state variable only assigned in constructor', () => {
      const source = `
pragma solidity ^0.8.0;
contract Test {
    address owner;

    constructor() {
        owner = msg.sender;
    }

    function getOwner() public view returns (address) {
        return owner;
    }
}
`;
      const suggestions = optimizer.analyze(source);
      const immutableSuggestions = suggestions.filter((s) => s.rule === 'immutable-candidate');
      expect(immutableSuggestions.length).toBeGreaterThan(0);
      expect(immutableSuggestions[0].message).toContain('immutable');
      expect(immutableSuggestions[0].message).toContain('owner');
    });

    it('should NOT flag variables already marked immutable', () => {
      const source = `
pragma solidity ^0.8.0;
contract Test {
    address immutable owner;

    constructor() {
        owner = msg.sender;
    }
}
`;
      const suggestions = optimizer.analyze(source);
      const immutableSuggestions = suggestions.filter((s) => s.rule === 'immutable-candidate');
      expect(immutableSuggestions).toEqual([]);
    });

    it('should NOT flag variables assigned in non-constructor functions', () => {
      const source = `
pragma solidity ^0.8.0;
contract Test {
    address owner;

    constructor() {
        owner = msg.sender;
    }

    function transferOwnership(address newOwner) public {
        owner = newOwner;
    }
}
`;
      const suggestions = optimizer.analyze(source);
      const immutableSuggestions = suggestions.filter((s) => s.rule === 'immutable-candidate');
      expect(immutableSuggestions).toEqual([]);
    });
  });

  describe('Rule: constant-candidate', () => {
    it('should detect state variable initialized with literal, never reassigned', () => {
      const source = `
pragma solidity ^0.8.0;
contract Test {
    uint256 maxSupply = 1000000;

    function getMax() public view returns (uint256) {
        return maxSupply;
    }
}
`;
      const suggestions = optimizer.analyze(source);
      const constantSuggestions = suggestions.filter((s) => s.rule === 'constant-candidate');
      expect(constantSuggestions.length).toBeGreaterThan(0);
      expect(constantSuggestions[0].message).toContain('constant');
    });

    it('should NOT flag variables already marked constant', () => {
      const source = `
pragma solidity ^0.8.0;
contract Test {
    uint256 constant MAX = 1000000;
}
`;
      const suggestions = optimizer.analyze(source);
      const constantSuggestions = suggestions.filter((s) => s.rule === 'constant-candidate');
      expect(constantSuggestions).toEqual([]);
    });

    it('should detect boolean constant candidate', () => {
      const source = `
pragma solidity ^0.8.0;
contract Test {
    bool isActive = true;

    function check() public view returns (bool) {
        return isActive;
    }
}
`;
      const suggestions = optimizer.analyze(source);
      const constantSuggestions = suggestions.filter((s) => s.rule === 'constant-candidate');
      expect(constantSuggestions.length).toBeGreaterThan(0);
    });
  });

  describe('Rule: custom-errors', () => {
    it('should detect require with string message', () => {
      const source = `
pragma solidity ^0.8.0;
contract Test {
    function withdraw(uint256 amount) public {
        require(amount > 0, "Amount must be positive");
    }
}
`;
      const suggestions = optimizer.analyze(source);
      const customErrorSuggestions = suggestions.filter((s) => s.rule === 'custom-errors');
      expect(customErrorSuggestions.length).toBe(1);
      expect(customErrorSuggestions[0].message).toContain('custom errors');
    });

    it('should NOT flag require without string message', () => {
      const source = `
pragma solidity ^0.8.0;
contract Test {
    error InsufficientBalance();
    function withdraw(uint256 amount) public {
        if (amount == 0) revert InsufficientBalance();
    }
}
`;
      const suggestions = optimizer.analyze(source);
      const customErrorSuggestions = suggestions.filter((s) => s.rule === 'custom-errors');
      expect(customErrorSuggestions).toEqual([]);
    });
  });

  describe('Rule: unchecked-loop-increment', () => {
    it('should detect for loop with i++', () => {
      const source = `
pragma solidity ^0.8.0;
contract Test {
    function process(uint256 n) public {
        for (uint256 i = 0; i < n; i++) {
            // process
        }
    }
}
`;
      const suggestions = optimizer.analyze(source);
      const uncheckedSuggestions = suggestions.filter((s) => s.rule === 'unchecked-loop-increment');
      expect(uncheckedSuggestions.length).toBe(1);
      expect(uncheckedSuggestions[0].message).toContain('unchecked');
    });

    it('should detect for loop with ++i', () => {
      const source = `
pragma solidity ^0.8.0;
contract Test {
    function process(uint256 n) public {
        for (uint256 i = 0; i < n; ++i) {
            // process
        }
    }
}
`;
      const suggestions = optimizer.analyze(source);
      const uncheckedSuggestions = suggestions.filter((s) => s.rule === 'unchecked-loop-increment');
      expect(uncheckedSuggestions.length).toBe(1);
    });

    it('should NOT flag loop already in unchecked block', () => {
      const source = `
pragma solidity ^0.8.0;
contract Test {
    function process(uint256 n) public {
        for (uint256 i = 0; i < n;) {
            // process
            unchecked { ++i; }
        }
    }
}
`;
      const suggestions = optimizer.analyze(source);
      const uncheckedSuggestions = suggestions.filter((s) => s.rule === 'unchecked-loop-increment');
      expect(uncheckedSuggestions).toEqual([]);
    });
  });

  describe('Rule: long-revert-string', () => {
    it('should detect require message longer than 32 bytes', () => {
      const source = `
pragma solidity ^0.8.0;
contract Test {
    function test() public {
        require(msg.sender != address(0), "This is a very long error message that exceeds thirty two bytes for sure");
    }
}
`;
      const suggestions = optimizer.analyze(source);
      const longStringSuggestions = suggestions.filter((s) => s.rule === 'long-revert-string');
      expect(longStringSuggestions.length).toBe(1);
      expect(longStringSuggestions[0].severity).toBe('warning');
    });

    it('should NOT flag short require messages', () => {
      const source = `
pragma solidity ^0.8.0;
contract Test {
    function test() public {
        require(msg.sender != address(0), "No zero");
    }
}
`;
      const suggestions = optimizer.analyze(source);
      const longStringSuggestions = suggestions.filter((s) => s.rule === 'long-revert-string');
      expect(longStringSuggestions).toEqual([]);
    });
  });

  describe('Rule: cache-storage-variable', () => {
    it('should detect storage variable read 3+ times in a function', () => {
      const source = `
pragma solidity ^0.8.0;
contract Test {
    uint256 totalSupply;

    function process() public {
        uint256 a = totalSupply;
        uint256 b = totalSupply + 1;
        uint256 c = totalSupply * 2;
        uint256 d = totalSupply - 1;
    }
}
`;
      const suggestions = optimizer.analyze(source);
      const cacheSuggestions = suggestions.filter((s) => s.rule === 'cache-storage-variable');
      expect(cacheSuggestions.length).toBeGreaterThan(0);
      expect(cacheSuggestions[0].message).toContain('totalSupply');
      expect(cacheSuggestions[0].message).toContain('Cache');
    });
  });

  describe('analyze - sorting', () => {
    it('should sort suggestions by line number', () => {
      const source = `
pragma solidity ^0.8.0;
contract Test {
    function a(uint256 n) public {
        for (uint256 i = 0; i < n; i++) {}
    }
    function b(uint256 amount) public {
        require(amount > 0, "Amount must be greater than zero so here is a long message");
    }
}
`;
      const suggestions = optimizer.analyze(source);
      for (let i = 1; i < suggestions.length; i++) {
        expect(suggestions[i].line).toBeGreaterThanOrEqual(suggestions[i - 1].line);
      }
    });
  });

  describe('generateReport', () => {
    it('should generate report with no suggestions', () => {
      const report = optimizer.generateReport([], 'Test.sol');
      expect(report).toContain('Gas Optimization Report: Test.sol');
      expect(report).toContain('No optimization opportunities detected');
    });

    it('should generate report with suggestions grouped by severity', () => {
      const suggestions = optimizer.analyze(`
pragma solidity ^0.8.0;
contract Test {
    function a(bytes memory data) external {}
    function b(uint256 n) public {
        for (uint256 i = 0; i < n; i++) {}
        require(n > 0, "Must be positive");
    }
}
`);
      const report = optimizer.generateReport(suggestions, 'Test.sol');
      expect(report).toContain('Gas Optimization Report: Test.sol');
      expect(report).toContain('optimization(s) found');
    });
  });
});
