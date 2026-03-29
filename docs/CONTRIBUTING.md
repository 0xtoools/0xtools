# Contributing to 0xTools

Thank you for your interest in contributing to 0xTools! This document provides guidelines and instructions for contributing to the project.

## Table of Contents

- [Development Environment](#development-environment)
- [Project Structure](#project-structure)
- [Building and Testing](#building-and-testing)
- [Development Workflow](#development-workflow)
- [Code Style](#code-style)
- [Submitting Changes](#submitting-changes)
- [Bug Reports](#bug-reports)
- [Feature Requests](#feature-requests)

## Development Environment

### Prerequisites

- **Node.js**: Version 16.0.0 or higher
- **npm**: Latest version
- **VS Code**: For extension development and testing
- **Git**: For version control

### Setup

1. **Fork and clone the repository**:
   ```bash
   git clone https://github.com/yourusername/sigScan.git
   cd sigScan
   ```

2. **Install dependencies**:
   ```bash
   npm install
   ```

3. **Install development tools**:
   ```bash
   npm install -g @vscode/vsce
   ```

4. **Open in VS Code**:
   ```bash
   code .
   ```

## Project Structure

```
sigScan/
├── src/
│   ├── extension/          # VS Code extension code
│   │   ├── extension.ts    # Main extension entry point
│   │   ├── manager.ts      # Core extension logic
│   │   └── providers/      # VS Code providers (tree view, etc.)
│   ├── core/              # Core scanning and parsing logic
│   │   ├── scanner.ts      # Project scanning
│   │   ├── parser.ts       # Solidity parsing
│   │   ├── exporter.ts     # File export functionality
│   │   └── watcher.ts      # File watching
│   ├── cli/               # Command-line interface
│   ├── utils/             # Utility functions
│   └── types.ts           # TypeScript type definitions
├── examples/              # Example contracts for testing
├── docs/                  # Documentation
├── test/                  # Test files
├── dist/                  # Compiled output
├── package.json          # Extension manifest
├── tsconfig.json         # TypeScript configuration
├── webpack.config.js     # Webpack configuration
└── README.md            # Main documentation
```

## Building and Testing

### Development Build

```bash
# Build in development mode
npm run dev

# Build and watch for changes
npm run watch
```

### Production Build

```bash
# Build for production
npm run compile

# Create VSIX package
vsce package
```

### Testing

```bash
# Run tests
npm test

# Run tests with coverage
npm run test:coverage

# Test the extension
# Press F5 in VS Code to launch Extension Development Host
```

### Manual Testing

1. **Open Extension Development Host**:
   - Press `F5` in VS Code
   - Or use Run and Debug panel → "Run Extension"

2. **Test with example projects**:
   ```bash
   # Test with included examples
   code examples/
   
   # Test with external projects
   code /path/to/your/solidity/project
   ```

3. **Test CLI functionality**:
   ```bash
   npm run cli scan --path ./examples
   npm run cli info --path ./examples
   ```

## Development Workflow

### Making Changes

1. **Create a feature branch**:
   ```bash
   git checkout -b feature/your-feature-name
   ```

2. **Make your changes** following the code style guidelines

3. **Test your changes**:
   - Run automated tests: `npm test`
   - Test extension in Development Host
   - Test CLI functionality
   - Test with multiple project types (Foundry, Hardhat)

4. **Commit your changes**:
   ```bash
   git add .
   git commit -m "feat: add your feature description"
   ```

5. **Push and create pull request**:
   ```bash
   git push origin feature/your-feature-name
   ```

### Commit Message Convention

We follow conventional commits:

- `feat:` - New features
- `fix:` - Bug fixes
- `docs:` - Documentation changes
- `style:` - Code style changes (formatting, etc.)
- `refactor:` - Code refactoring
- `test:` - Adding or updating tests
- `chore:` - Maintenance tasks

Examples:
```
feat: add support for custom error parsing
fix: resolve file watching issue on Windows
docs: update installation instructions
refactor: improve signature generation performance
```

## Code Style

### TypeScript Guidelines

- Use TypeScript strict mode
- Provide type annotations for public APIs
- Use meaningful variable and function names
- Follow existing patterns in the codebase

### Formatting

We use ESLint and TypeScript compiler for code quality:

```bash
# Check linting
npm run lint

# Fix linting issues
npm run lint:fix
```

### Code Organization

- Keep functions focused and single-purpose
- Use proper error handling with try/catch blocks
- Add JSDoc comments for public functions
- Organize imports: Node.js modules, third-party, local modules

### Example Code Style

```typescript
/**
 * Parse a Solidity contract file and extract signatures
 * @param filePath - Absolute path to the contract file
 * @returns Contract information with parsed signatures
 */
public async parseContract(filePath: string): Promise<ContractInfo | null> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const contractName = this.extractContractName(content);
    
    if (!contractName) {
      return null;
    }

    return {
      name: contractName,
      filePath,
      functions: this.parseFunctions(content),
      events: this.parseEvents(content),
      errors: this.parseErrors(content)
    };
  } catch (error) {
    console.error(`Error parsing contract ${filePath}:`, error);
    return null;
  }
}
```

## Submitting Changes

### Pull Request Guidelines

1. **Ensure your code follows the style guidelines**
2. **Write or update tests** for your changes
3. **Update documentation** if needed
4. **Test thoroughly** on different project types
5. **Write a clear PR description** explaining the changes

### Pull Request Template

```markdown
## Description
Brief description of the changes made.

## Type of Change
- [ ] Bug fix
- [ ] New feature
- [ ] Documentation update
- [ ] Performance improvement
- [ ] Other (please describe)

## Testing
- [ ] Automated tests pass
- [ ] Extension tested in Development Host
- [ ] CLI functionality tested
- [ ] Tested with Foundry projects
- [ ] Tested with Hardhat projects

## Checklist
- [ ] Code follows style guidelines
- [ ] Self-review completed
- [ ] Documentation updated
- [ ] No breaking changes (or properly documented)
```

### Review Process

1. **Automated checks** must pass (tests, linting)
2. **Manual review** by maintainers
3. **Testing** on different environments
4. **Approval** and merge

## Bug Reports

When reporting bugs, please include:

### Required Information

- **0xTools version**: Extension version number
- **VS Code version**: Help → About
- **Operating System**: Windows/macOS/Linux version
- **Project type**: Foundry/Hardhat/other
- **Steps to reproduce**: Detailed steps
- **Expected behavior**: What should happen
- **Actual behavior**: What actually happens
- **Error messages**: Console errors, extension logs

### Example Bug Report

```markdown
**0xTools Version**: 0.1.0
**VS Code Version**: 1.80.0
**OS**: Ubuntu 22.04

**Description**: Extension fails to parse contracts with custom imports

**Steps to Reproduce**:
1. Open Foundry project with contracts using `import "./Custom.sol"`
2. Run "0xTools: Scan Project for Signatures"
3. Check output - contracts with custom imports are missing

**Expected**: All contracts should be parsed
**Actual**: Contracts with imports are skipped

**Error Logs**:
```
Error parsing contract: Cannot resolve import path
```
```

## Feature Requests

For new features, please provide:

- **Use case**: Why is this feature needed?
- **Description**: What should the feature do?
- **Examples**: How would it work?
- **Alternatives**: Any workarounds currently used?

## Development Tips

### Debugging the Extension

1. **Use VS Code Developer Tools**:
   ```
   Help → Toggle Developer Tools
   ```

2. **Add console.log statements** for debugging:
   ```typescript
   console.log('0xTools Debug:', data);
   ```

3. **Use VS Code Output panel** to view extension logs

### Testing with Different Project Types

```bash
# Create test projects
mkdir test-foundry && cd test-foundry
forge init

mkdir test-hardhat && cd test-hardhat
npx hardhat init
```

### Working with the Parser

The Solidity parser is in `src/core/parser.ts`. When adding new parsing capabilities:

1. **Add test contracts** in `examples/`
2. **Write unit tests** for parser functions
3. **Handle edge cases** gracefully
4. **Update type definitions** if needed

### Performance Considerations

- Use **async/await** for file operations
- **Cache parsed results** when appropriate
- **Throttle file watching** events
- **Optimize RegExp patterns** for parsing

## Questions and Support

- **GitHub Discussions**: For questions and discussions
- **GitHub Issues**: For bug reports and feature requests
- **Email**: Contact maintainers directly for sensitive issues

Thank you for contributing to 0xTools! 🚀
