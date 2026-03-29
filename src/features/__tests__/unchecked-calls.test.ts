/**
 * Tests for Unchecked Call Return Detector
 */

import { UncheckedCallDetector } from '../unchecked-calls';

describe('UncheckedCallDetector', () => {
  let detector: UncheckedCallDetector;

  beforeEach(() => {
    detector = new UncheckedCallDetector();
  });

  describe('detect - empty/trivial input', () => {
    it('should return empty array for empty source', () => {
      const warnings = detector.detect('');
      expect(warnings).toEqual([]);
    });

    it('should return empty array for contract without low-level calls', () => {
      const source = `
pragma solidity ^0.8.0;
contract Safe {
    function add(uint256 a, uint256 b) public pure returns (uint256) {
        return a + b;
    }
}
`;
      const warnings = detector.detect(source);
      expect(warnings).toEqual([]);
    });
  });

  describe('detect - unchecked .call()', () => {
    it('should detect unchecked .call()', () => {
      const source = `
pragma solidity ^0.8.0;
contract Test {
    function withdraw() public {
        payable(msg.sender).call{value: 100}("");
    }
}
`;
      const warnings = detector.detect(source);
      const callWarning = warnings.find((w) => w.callType === '.call()');
      expect(callWarning).toBeDefined();
      expect(callWarning!.description).toContain('.call()');
    });

    it('should NOT flag checked .call() with bool assignment', () => {
      const source = `
pragma solidity ^0.8.0;
contract Test {
    function withdraw() public {
        (bool success, ) = payable(msg.sender).call{value: 100}("");
        require(success, "failed");
    }
}
`;
      const warnings = detector.detect(source);
      const callWarning = warnings.find((w) => w.callType === '.call()');
      expect(callWarning).toBeUndefined();
    });

    it('should NOT flag .call() inside require', () => {
      const source = `
pragma solidity ^0.8.0;
contract Test {
    function withdraw() public {
        require(payable(msg.sender).send(100), "failed");
    }
}
`;
      const warnings = detector.detect(source);
      const sendWarning = warnings.find((w) => w.callType === '.send()');
      expect(sendWarning).toBeUndefined();
    });
  });

  describe('detect - unchecked .delegatecall()', () => {
    it('should detect unchecked .delegatecall()', () => {
      const source = `
pragma solidity ^0.8.0;
contract Test {
    function execute(address target) public {
        target.delegatecall(abi.encodeWithSignature("run()"));
    }
}
`;
      const warnings = detector.detect(source);
      const dcWarning = warnings.find((w) => w.callType === '.delegatecall()');
      expect(dcWarning).toBeDefined();
      expect(dcWarning!.description).toContain('delegatecall');
    });

    it('should NOT flag checked delegatecall', () => {
      const source = `
pragma solidity ^0.8.0;
contract Test {
    function execute(address target) public {
        (bool success, bytes memory data) = target.delegatecall(abi.encodeWithSignature("run()"));
        require(success, "failed");
    }
}
`;
      const warnings = detector.detect(source);
      const dcWarning = warnings.find((w) => w.callType === '.delegatecall()');
      expect(dcWarning).toBeUndefined();
    });
  });

  describe('detect - unchecked .staticcall()', () => {
    it('should detect unchecked .staticcall()', () => {
      const source = `
pragma solidity ^0.8.0;
contract Test {
    function query(address target) public {
        target.staticcall(abi.encodeWithSignature("get()"));
    }
}
`;
      const warnings = detector.detect(source);
      const scWarning = warnings.find((w) => w.callType === '.staticcall()');
      expect(scWarning).toBeDefined();
    });
  });

  describe('detect - unchecked .send()', () => {
    it('should detect unchecked .send()', () => {
      const source = `
pragma solidity ^0.8.0;
contract Test {
    function pay() public {
        payable(msg.sender).send(100);
    }
}
`;
      const warnings = detector.detect(source);
      const sendWarning = warnings.find((w) => w.callType === '.send()');
      expect(sendWarning).toBeDefined();
      expect(sendWarning!.description).toContain('.send()');
    });
  });

  describe('detect - unsafe ERC20 calls', () => {
    it('should detect direct IERC20.transfer()', () => {
      const source = `
pragma solidity ^0.8.0;
contract Test {
    function send(address token, address to, uint256 amount) public {
        IERC20(token).transfer(to, amount);
    }
}
`;
      const warnings = detector.detect(source);
      const erc20Warning = warnings.find((w) => w.callType === 'unsafe-erc20');
      expect(erc20Warning).toBeDefined();
      expect(erc20Warning!.description).toContain('SafeERC20');
    });

    it('should detect direct IERC20.transferFrom()', () => {
      const source = `
pragma solidity ^0.8.0;
contract Test {
    function pull(address token, address from, uint256 amount) public {
        IERC20(token).transferFrom(from, address(this), amount);
    }
}
`;
      const warnings = detector.detect(source);
      const erc20Warning = warnings.find(
        (w) => w.callType === 'unsafe-erc20' && w.description.includes('transferFrom')
      );
      expect(erc20Warning).toBeDefined();
    });

    it('should detect direct IERC20.approve()', () => {
      const source = `
pragma solidity ^0.8.0;
contract Test {
    function approveSpender(address token, address spender) public {
        IERC20(token).approve(spender, type(uint256).max);
    }
}
`;
      const warnings = detector.detect(source);
      const erc20Warning = warnings.find(
        (w) => w.callType === 'unsafe-erc20' && w.description.includes('approve')
      );
      expect(erc20Warning).toBeDefined();
    });

    it('should NOT flag safeTransfer calls', () => {
      const source = `
pragma solidity ^0.8.0;
contract Test {
    using SafeERC20 for IERC20;
    function send(address token, address to, uint256 amount) public {
        IERC20(token).safeTransfer(to, amount);
    }
}
`;
      const warnings = detector.detect(source);
      const erc20Warning = warnings.find((w) => w.callType === 'unsafe-erc20');
      expect(erc20Warning).toBeUndefined();
    });
  });

  describe('detect - comment handling', () => {
    it('should skip lines that are comments', () => {
      const source = `
pragma solidity ^0.8.0;
contract Test {
    function test() public {
        // payable(msg.sender).send(100);
        /* target.delegatecall(data); */
    }
}
`;
      const warnings = detector.detect(source);
      expect(warnings).toEqual([]);
    });
  });

  describe('detect - function tracking', () => {
    it('should correctly associate warnings with their enclosing function', () => {
      const source = `
pragma solidity ^0.8.0;
contract Test {
    function functionA() public {
        // safe
    }

    function functionB() public {
        payable(msg.sender).send(100);
    }
}
`;
      const warnings = detector.detect(source);
      const sendWarning = warnings.find((w) => w.callType === '.send()');
      expect(sendWarning).toBeDefined();
      expect(sendWarning!.functionName).toBe('functionB');
    });
  });

  describe('generateReport', () => {
    it('should generate report with no warnings', () => {
      const report = detector.generateReport([]);
      expect(report).toContain('Unchecked Low-Level Calls Report');
      expect(report).toContain('No unchecked low-level calls found');
    });

    it('should generate report separating low-level and ERC20 warnings', () => {
      const warnings = [
        {
          line: 5,
          functionName: 'withdraw',
          callType: '.call()',
          description: 'Low-level .call() return value not checked.',
        },
        {
          line: 10,
          functionName: 'transfer',
          callType: 'unsafe-erc20',
          description: 'Direct IERC20.transfer() without SafeERC20.',
        },
      ];

      const report = detector.generateReport(warnings);
      expect(report).toContain('2');
      expect(report).toContain('1 unchecked call(s)');
      expect(report).toContain('1 unsafe ERC20 call(s)');
      expect(report).toContain('withdraw');
      expect(report).toContain('SafeERC20');
    });

    it('should include fix suggestion with code example', () => {
      const warnings = [
        {
          line: 5,
          functionName: 'test',
          callType: '.call()',
          description: 'Unchecked .call()',
        },
      ];

      const report = detector.generateReport(warnings);
      expect(report).toContain('(bool success, )');
      expect(report).toContain('require(success');
    });
  });
});
