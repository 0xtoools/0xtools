# Inline Gas Annotations (Remix-Style)

## Overview

0xTools now displays **inline gas cost estimates** directly in your Solidity files, similar to Remix IDE! Each function shows estimated gas costs right next to the function signature.

## Features

### 🎯 Automatic Inline Annotations

When you open or edit a Solidity file, 0xTools automatically:
- Analyzes each function's gas consumption
- Displays estimated gas costs inline (e.g., `// ⛽ 23,450 gas`)
- Color-codes annotations based on complexity:
  - 🟢 **Green**: Low gas (< 10,000)
  - 🟡 **Yellow**: Medium gas (10,000 - 50,000)
  - 🟠 **Orange**: High gas (50,000 - 100,000)
  - 🔴 **Red**: Very high gas (> 100,000)

### 📊 Rich Hover Information

Hover over any gas annotation to see detailed breakdown:
- **Gas Range**: Min - Max estimates
- **Average Gas**: Most likely cost
- **Complexity Level**: Low, Medium, High, Very High
- **Cost Factors**: What contributes to gas usage
- **Warnings**: Potential optimization opportunities

## Usage

### Enable/Disable

The feature is **enabled by default**. To toggle:

1. **Command Palette** (Ctrl+Shift+P / Cmd+Shift+P)
2. Search: `0xTools: Toggle Real-time Analysis`
3. Or use VS Code settings: `sigscan.realtimeAnalysis`

### Example

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract Example {
    mapping(address => uint256) public balances;

    // This will show: // ⛽ 2,345 gas (green)
    function getBalance(address account) public view returns (uint256) {
        return balances[account];
    }

    // This will show: // ⛽ 45,678 gas (orange)
    function batchTransfer(address[] calldata recipients, uint256 amount) public {
        for (uint256 i = 0; i < recipients.length; i++) {
            balances[msg.sender] -= amount;
            balances[recipients[i]] += amount;
        }
    }
}
```

## How It Works

### Real-Time Analysis

1. **Parse**: Extracts all functions from your Solidity code
2. **Analyze**: Estimates gas based on:
   - Operation types (SLOAD, SSTORE, CALL, etc.)
   - Loop complexity
   - Storage vs memory usage
   - External calls
3. **Display**: Shows annotations inline with color coding
4. **Cache**: Results cached for 5 seconds for performance

### Gas Estimation Factors

0xTools considers:
- **Storage Operations**: SLOAD (200 gas), SSTORE (5,000-20,000 gas)
- **Memory Operations**: MLOAD (3 gas), MSTORE (3 gas)
- **Arithmetic**: ADD (3 gas), MUL (5 gas), DIV (5 gas)
- **Loops**: Multiplies base cost by estimated iterations
- **External Calls**: 2,600+ gas base cost
- **Events**: LOG operations (375+ gas per topic)

## Configuration

Add to your VS Code `settings.json`:

```json
{
  "sigscan.realtimeAnalysis": true,  // Enable/disable inline annotations
  "sigscan.autoScan": true,          // Auto-scan on startup
  "editor.inlayHints.enabled": "on"  // Ensure decorations are visible
}
```

## Comparison with Remix

| Feature | Remix | 0xTools |
|---------|-------|---------|
| Inline gas display | ✅ | ✅ |
| Real-time updates | ✅ | ✅ |
| Hover details | ⚠️ Limited | ✅ Rich |
| Complexity warnings | ❌ | ✅ |
| Works in VS Code | ❌ | ✅ |
| Offline mode | ❌ | ✅ |
| Color coding | ✅ | ✅ |

## Performance

- **Analysis Speed**: < 50ms per file
- **Cache TTL**: 5 seconds
- **Memory Usage**: Minimal (LRU cache)
- **No Network Required**: All analysis is local

## Tips & Best Practices

### 1. Optimize High Gas Functions
If you see **red** or **orange** annotations:
- Review loops for gas optimization
- Consider storage vs memory usage
- Check for redundant operations
- Look for batch processing opportunities

### 2. Use View/Pure Functions
Functions marked `view` or `pure` show gas for external calls:
- **View**: Reads state, free when called locally
- **Pure**: No state access, free when called locally
- Gas shown is for when called from another contract

### 3. Watch for Warnings
Hover over annotations to see warnings:
- "Unbounded loop detected"
- "Multiple storage writes"
- "Expensive external call"
- "Large array operation"

### 4. Test with Runtime Profiler
For actual gas costs from test execution:
```bash
# Run Foundry tests with gas reporting
forge test --gas-report

# 0xTools will compare estimates vs actuals
```

## Demo

Open `examples/src/GasDemo.sol` to see annotations in action:

- **Simple functions**: ~2,000-5,000 gas (green)
- **Storage operations**: ~20,000-50,000 gas (yellow/orange)
- **Complex loops**: > 100,000 gas (red)

## Troubleshooting

### Annotations Not Showing?

1. **Check setting**: `sigscan.realtimeAnalysis` should be `true`
2. **File language**: Ensure file is recognized as Solidity
3. **Reload window**: Press F1 → "Developer: Reload Window"

### Wrong Gas Estimates?

- Estimates are **approximations** based on static analysis
- Actual costs depend on:
  - Network conditions
  - Contract state
  - Transaction input size
  - EVM optimizations
- Use runtime profiler for actual measurements

### Performance Issues?

- Large files (> 1000 lines) may take longer
- Clear cache: F1 → "0xTools: Refresh Signatures"
- Disable for specific files if needed

## Related Features

- **Diagnostics**: Warnings in Problems panel
- **Hover Info**: Detailed gas breakdown
- **Runtime Profiler**: Compare with actual gas usage
- **Complexity Analysis**: Code quality metrics

## Feedback

Found an issue or have suggestions?
- GitHub: https://github.com/DevJSter/sigScan
- Report bugs with gas estimate examples

---

**Next Steps**: Open a Solidity file and watch the gas annotations appear automatically! 🚀
