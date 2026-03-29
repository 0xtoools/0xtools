# 0xTools Extension - Installation & Building Guide

## Table of Contents

- [Installation Methods](#installation-methods)
- [Building from Source](#building-from-source)
- [Development Setup](#development-setup)
- [Extension Packaging](#extension-packaging)
- [Publishing](#publishing)
- [Troubleshooting](#troubleshooting)

## Installation Methods

### Method 1: Install Pre-built Extension (Recommended)

If you have a pre-built `.vsix` file:

```bash
# Install the extension
code --install-extension sigscan-0.1.0.vsix

# Force reinstall if already installed
code --install-extension sigscan-0.1.0.vsix --force
```

### Method 2: Install from VS Code Marketplace (Coming Soon)

1. Open VS Code
2. Go to Extensions (`Ctrl+Shift+X`)
3. Search for "0xTools"
4. Click "Install"

### Method 3: Install from GitHub Releases

1. Go to [GitHub Releases](https://github.com/0xshubhs/sigScan/releases)
2. Download the latest `sigscan-x.x.x.vsix` file
3. Install using VS Code command line:
   ```bash
   code --install-extension path/to/sigscan-x.x.x.vsix
   ```

## Building from Source

### Prerequisites

Ensure you have the following installed:

- **Node.js** (≥16.0.0): [Download](https://nodejs.org/)
- **npm** (comes with Node.js)
- **Git**: [Download](https://git-scm.com/)
- **VS Code**: [Download](https://code.visualstudio.com/)

### Step-by-Step Build Process

#### 1. Clone the Repository

```bash
git clone https://github.com/0xshubhs/sigScan.git
cd sigScan
```

#### 2. Install Dependencies

```bash
# Install project dependencies
npm install

# Install VS Code Extension Manager globally
npm install -g @vscode/vsce
```

#### 3. Build the Project

```bash
# Build for production
npm run compile

# Alternative: Build for development
npm run dev
```

#### 4. Package the Extension

```bash
# Create VSIX package
vsce package
```

This creates a `sigscan-0.1.0.vsix` file in the project root.

#### 5. Install the Built Extension

```bash
# Install the packaged extension
code --install-extension sigscan-0.1.0.vsix
```

### Build Scripts Reference

| Script | Command | Description |
|--------|---------|-------------|
| **Development** | `npm run dev` | Build in development mode |
| **Watch** | `npm run watch` | Build and watch for changes |
| **Production** | `npm run compile` | Build for production (optimized) |
| **Pre-publish** | `npm run vscode:prepublish` | Runs before packaging |
| **Package** | `vsce package` | Create VSIX package |
| **Test** | `npm test` | Run test suite |

## Development Setup

### Setting up Development Environment

#### 1. Open in VS Code

```bash
code /path/to/sigScan
```

#### 2. Install Recommended Extensions

VS Code will prompt you to install recommended extensions. Click "Install All" or install manually:

- TypeScript and JavaScript Language Features
- ESLint
- Prettier

#### 3. Configure Development Settings

Create `.vscode/settings.json` (if not exists):

```json
{
  "typescript.preferences.useAliasesForRenames": false,
  "typescript.preferences.includePackageJsonAutoImports": "off",
  "typescript.suggest.autoImports": true,
  "editor.codeActionsOnSave": {
    "source.fixAll.eslint": true
  }
}
```

### Running in Development Mode

#### Method 1: Using F5 Key

1. Open the project in VS Code
2. Press `F5` (or `Fn+F5` on some keyboards)
3. Select "Run Extension" if prompted
4. A new VS Code window opens with the extension loaded

#### Method 2: Using Debug Panel

1. Go to Run and Debug panel (`Ctrl+Shift+D`)
2. Select "Run Extension" from the dropdown
3. Click the green play button
4. Extension Development Host window opens

### Hot Reloading

When running in development mode:

1. Make changes to source files
2. Save the files (`Ctrl+S`)
3. Press `Ctrl+R` in the Extension Development Host window
4. Changes are reloaded automatically

## Extension Packaging

### Basic Packaging

```bash
# Basic package creation
vsce package
```

### Advanced Packaging Options

```bash
# Package with specific version
vsce package --out sigscan-1.0.0.vsix

# Package without installing devDependencies
vsce package --no-dependencies

# Package with yarn instead of npm
vsce package --yarn

# Package with pre-release flag
vsce package --pre-release
```

### Before Packaging Checklist

- [ ] Update version in `package.json`
- [ ] Update changelog
- [ ] Run tests: `npm test`
- [ ] Test extension manually
- [ ] Ensure all files are committed
- [ ] Run production build: `npm run compile`

## Publishing

### Publishing to VS Code Marketplace

#### 1. Get Publisher Access Token

1. Go to [Azure DevOps](https://dev.azure.com/)
2. Create a Personal Access Token
3. Set it up for VS Code marketplace

#### 2. Create Publisher Account

```bash
# Create publisher (one-time setup)
vsce create-publisher your-publisher-name
```

#### 3. Login to Marketplace

```bash
# Login with your access token
vsce login your-publisher-name
```

#### 4. Publish Extension

```bash
# Publish current version
vsce publish

# Publish with version bump
vsce publish patch  # 1.0.0 -> 1.0.1
vsce publish minor  # 1.0.0 -> 1.1.0
vsce publish major  # 1.0.0 -> 2.0.0

# Publish pre-release
vsce publish --pre-release
```

### Publishing to GitHub Releases

#### 1. Create GitHub Release

```bash
# Create a git tag
git tag v1.0.0
git push origin v1.0.0
```

#### 2. Upload VSIX File

1. Go to GitHub repository
2. Click "Releases"
3. Click "Create a new release"
4. Upload the `.vsix` file as an asset

## Troubleshooting

### Common Build Issues

#### Issue: `vsce` Command Not Found

```bash
# Solution: Install vsce globally
npm install -g @vscode/vsce

# Alternative: Use npx
npx @vscode/vsce package
```

#### Issue: TypeScript Compilation Errors

```bash
# Check TypeScript configuration
npx tsc --noEmit

# Fix ESLint issues
npm run lint:fix
```

#### Issue: Missing Dependencies

```bash
# Clean install dependencies
rm -rf node_modules package-lock.json
npm install
```

#### Issue: Extension Activation Problems

1. Check `activationEvents` in `package.json`
2. Verify extension entry point in `main` field
3. Check for JavaScript errors in VS Code Developer Tools

### Debugging Extension Issues

#### 1. Enable Debug Mode

In Extension Development Host window:
- Open Developer Tools: `Help` → `Toggle Developer Tools`
- Check Console for errors

#### 2. Check Extension Logs

1. Open Output panel in VS Code
2. Select "0xTools" from dropdown
3. Look for error messages

#### 3. Test Extension Commands

1. Open Command Palette (`Ctrl+Shift+P`)
2. Type "0xTools" to see available commands
3. Test each command individually

### Build Environment Issues

#### Node.js Version Issues

```bash
# Check Node.js version
node --version  # Should be ≥16.0.0

# Update Node.js if needed
npm install -g n
n latest
```

#### Permission Issues on Linux/macOS

```bash
# Fix npm permissions
sudo chown -R $(whoami) ~/.npm
```

### Extension Size Optimization

If the extension package is too large:

#### 1. Check `.vscodeignore`

```gitignore
.vscode-test/**
out/test/**
test/**
src/**
.gitignore
vsc-extension-quickstart.md
**/tsconfig.json
**/.eslintrc.json
**/tslint.json
**/.prettierrc
```

#### 2. Exclude Unnecessary Files

Add to `.vscodeignore`:
```
node_modules/
.vscode-test/
src/
.git/
.github/
docs/
examples/
*.vsix
```

#### 3. Use Webpack Bundle

The project already uses webpack for optimization. Check `webpack.config.js` for bundle settings.

## Support

If you encounter issues:

1. **Check this guide** for common solutions
2. **Search GitHub Issues** for similar problems
3. **Create a new issue** with:
   - Operating system and version
   - Node.js and npm versions
   - Complete error messages
   - Steps to reproduce

## Next Steps

After successful installation:

1. **Read the [Extension Guide](EXTENSION_GUIDE.md)** for usage instructions
2. **Check the [Usage Guide](../USAGE.md)** for examples
3. **Try the extension** with your Solidity projects
4. **Report bugs** or **suggest features** on GitHub
