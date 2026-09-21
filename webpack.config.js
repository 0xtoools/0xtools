const path = require('path');

/** @param {Record<string, string>} env */
/** @param {{ mode?: string }} argv */
module.exports = (_env, argv) => {
  const isProduction = argv.mode === 'production';

  /** @type {import('webpack').Configuration} */
  const extensionConfig = {
    name: 'extension',
    target: 'node',
    entry: {
      'extension/extension': './src/extension/extension.ts',
      'cli/index': './src/cli/index.ts',
    },
    output: {
      path: path.resolve(__dirname, 'dist'),
      filename: '[name].js',
      libraryTarget: 'commonjs2',
      chunkFormat: 'commonjs',
    },
    externals: {
      vscode: 'commonjs vscode',
      sqlite3: 'commonjs sqlite3',
      fsevents: 'commonjs fsevents',
      // solc is ~9 MB of WASM; keep it external — loaded from node_modules at runtime.
      // SolcManager.ts already lazy-loads it via require('solc'), so this is safe.
      solc: 'commonjs solc',
    },
    resolve: {
      extensions: ['.ts', '.js'],
      fallback: {
        fsevents: false,
        // ws (pulled in by ethers' WebSocket provider) probes for these native
        // speed-ups inside a try/catch and works fine without them.
        bufferutil: false,
        'utf-8-validate': false,
      },
    },
    module: {
      rules: [
        {
          test: /\.ts$/,
          exclude: [/node_modules/, /__tests__/, /\.test\.ts$/, /\.spec\.ts$/, /[\\/]webview[\\/]/],
          use: {
            loader: 'ts-loader',
            options: {
              // Skip type-checking during build (use `tsc --noEmit` separately)
              transpileOnly: true,
              // Keep the tsconfig CommonJS emit. An es2020 override was tried to
              // tree-shake ethers' HD-wallet code, but abi-guesser is CJS and
              // require()s ethers, so webpack bundles a second full ethers copy
              // and the bundle grows instead of shrinking.
            },
          },
        },
      ],
    },
    cache: {
      type: 'filesystem',
      name: 'extension',
      buildDependencies: {
        config: [__filename],
      },
    },
    optimization: {
      minimize: isProduction,
      sideEffects: true,
      moduleIds: 'deterministic',
      // No splitChunks for this node/commonjs2 target. Code-splitting is a web
      // optimization; for disk-loaded Node bundles a shared "vendors" chunk only
      // adds require() overhead and lets CLI vendor code leak into the extension
      // load path (and vice-versa). Let each entry bundle independently.
      splitChunks: false,
    },
    devtool: isProduction ? 'source-map' : 'eval-source-map',
    ignoreWarnings: [
      {
        module: /node_modules\/chokidar/,
        message: /Can't resolve 'fsevents'/,
      },
    ],
  };

  /** @type {import('webpack').Configuration} */
  const webviewConfig = {
    name: 'webview',
    target: 'web',
    entry: {
      'webview/deploy-run': './src/webview/deploy-run/index.tsx',
    },
    output: {
      path: path.resolve(__dirname, 'dist'),
      filename: '[name].js',
      // webview bundle is loaded via <script src> in an iframe; no library wrapping
      libraryTarget: 'window',
    },
    resolve: {
      extensions: ['.tsx', '.ts', '.js'],
    },
    module: {
      rules: [
        {
          test: /\.tsx?$/,
          exclude: [/node_modules/, /__tests__/, /\.test\.tsx?$/],
          use: {
            loader: 'ts-loader',
            options: {
              transpileOnly: true,
              configFile: path.resolve(__dirname, 'tsconfig.webview.json'),
            },
          },
        },
      ],
    },
    cache: {
      type: 'filesystem',
      name: 'webview',
      buildDependencies: {
        config: [__filename],
      },
    },
    optimization: {
      minimize: isProduction,
      moduleIds: 'deterministic',
    },
    devtool: isProduction ? 'source-map' : 'eval-source-map',
    performance: {
      // React + ReactDOM gzipped is ~45kb; the webview bundle is small enough not to warn
      hints: false,
    },
  };

  return [extensionConfig, webviewConfig];
};
