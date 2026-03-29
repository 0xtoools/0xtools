const path = require('path');

/** @param {Record<string, string>} env */
/** @param {{ mode?: string }} argv */
module.exports = (_env, argv) => {
  const isProduction = argv.mode === 'production';

  return {
    target: 'node',
    // mode is controlled by the CLI --mode flag; do NOT hardcode it here
    entry: {
      'extension/extension': './src/extension/extension.ts',
      'cli/index': './src/cli/index.ts'
    },
    output: {
      path: path.resolve(__dirname, 'dist'),
      filename: '[name].js',
      libraryTarget: 'commonjs2',
      chunkFormat: 'commonjs'
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
        fsevents: false
      }
    },
    module: {
      rules: [
        {
          test: /\.ts$/,
          exclude: [/node_modules/, /__tests__/, /\.test\.ts$/, /\.spec\.ts$/],
          use: {
            loader: 'ts-loader',
            options: {
              // Skip type-checking during build (use `tsc --noEmit` separately)
              transpileOnly: true
            }
          }
        }
      ]
    },
    // Filesystem cache for dramatically faster rebuilds
    cache: {
      type: 'filesystem',
      buildDependencies: {
        config: [__filename]
      }
    },
    optimization: {
      minimize: isProduction,
      // Enable tree-shaking: mark all modules as side-effect-free unless stated otherwise
      sideEffects: true,
      // Deterministic module/chunk ids for better long-term caching
      moduleIds: 'deterministic',
      // Split common code between extension and cli entry points
      splitChunks: isProduction ? {
        chunks: 'all',
        minSize: 30000,
        cacheGroups: {
          // Separate large dependencies (solc, semver, etc.) into a shared chunk
          vendors: {
            test: /[\\/]node_modules[\\/]/,
            name: 'vendors',
            chunks: 'all',
            priority: -10
          }
        }
      } : false
    },
    devtool: isProduction ? 'source-map' : 'eval-source-map',
    ignoreWarnings: [
      {
        module: /node_modules\/chokidar/,
        message: /Can't resolve 'fsevents'/,
      },
    ]
  };
};
