# Contributing to 0xTools

First off, thank you for considering contributing to 0xTools! 🎉

## Code of Conduct

By participating in this project, you agree to abide by our Code of Conduct. Please be respectful and constructive in all interactions.

## How Can I Contribute?

### Reporting Bugs

Before creating bug reports, please check existing issues. When creating a bug report, include:

- **Clear title and description**
- **Steps to reproduce**
- **Expected vs actual behavior**
- **Screenshots** (if applicable)
- **Environment details** (VS Code version, OS, Node version)

### Suggesting Enhancements

Enhancement suggestions are welcome! Please include:

- **Clear use case**
- **Expected behavior**
- **Why this would be useful**
- **Examples** from other tools (if applicable)

### Pull Requests

1. Fork the repo and create your branch from `main`
2. Follow the setup instructions in [BUILDING.md](BUILDING.md)
3. Make your changes and add tests
4. Ensure the test suite passes: `npm test`
5. Run linting: `npm run lint:fix`
6. Format code: `npm run format`
7. Commit with conventional commits: `feat:`, `fix:`, `docs:`, etc.
8. Push to your fork and submit a pull request

**Note:** Branches are automatically deleted after PR merge. Don't worry about cleanup! 🧹

## Automated Branch Management

### Branch Cleanup

This repository uses automated workflows to keep branches clean:

- **Auto-delete on merge**: When a PR is merged, the source branch is automatically deleted
- **Dependabot branches**: Special handling for dependabot PRs - branches auto-delete after merge
- **Stale branch cleanup**: Weekly automated cleanup of old branches (90+ days inactive)
- **Manual trigger**: You can manually trigger cleanup via GitHub Actions

### Dependabot Auto-Merge

For dependency updates:
- **Patch/Minor updates**: Auto-approved and auto-merged after CI passes
- **Major updates**: Requires manual review (commented with warning)
- **All updates**: Branches automatically deleted after merge

No manual branch cleanup needed! 🎉

## Development Setup

```bash
# Clone your fork
git clone https://github.com/YOUR_USERNAME/sigScan.git
cd sigScan

# Install dependencies
npm install

# Run tests
npm test

# Build extension
npm run compile

# Package extension
npm run package
```

## Commit Message Guidelines

We follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <subject>

<body>

<footer>
```

### Types

- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation only
- `style`: Code style (formatting, etc.)
- `refactor`: Code refactoring
- `perf`: Performance improvement
- `test`: Adding tests
- `build`: Build system changes
- `ci`: CI configuration
- `chore`: Maintenance tasks

### Examples

```
feat(scanner): add support for Solidity 0.8.20

fix(exporter): resolve duplicate signature issue

docs(readme): update installation instructions
```

## Testing

- Write tests for new features
- Ensure existing tests pass
- Aim for good code coverage
- Test on multiple platforms if possible

## Style Guide

- Use TypeScript
- Follow ESLint rules
- Use Prettier for formatting
- Write clear, descriptive variable names
- Add JSDoc comments for public APIs

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
