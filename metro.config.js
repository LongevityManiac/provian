const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');
const fs = require('fs');

const config = getDefaultConfig(__dirname);

// Metro must watch the actual dependency directory when a checkout uses a node_modules symlink.
const dependencyRoot = fs.realpathSync(path.join(__dirname, 'node_modules'));
config.watchFolders = [...(config.watchFolders || []), dependencyRoot];
config.resolver.nodeModulesPaths = [...(config.resolver.nodeModulesPaths || []), dependencyRoot];

// Create shim path
const shimPath = path.resolve(__dirname, 'shims');

// Path to jose browser distribution
const joseWebApiPath = path.resolve(__dirname, 'node_modules/jose/dist/webapi');

// Resolve Node.js modules that don't exist in React Native
config.resolver.extraNodeModules = {
  ...config.resolver.extraNodeModules,
  crypto: path.join(shimPath, 'crypto-shim.js'),
  stream: require.resolve('readable-stream'),
  buffer: require.resolve('buffer'),
  util: path.join(shimPath, 'util-shim.js'),
  zlib: path.join(shimPath, 'zlib-shim.js'),
  // Polyfills for @coral-xyz/anchor (Marinade SDK dependency)
  process: require.resolve('process'),
  assert: require.resolve('assert'),
  fs: path.join(shimPath, 'fs-shim.js'),
  path: path.join(shimPath, 'path-shim.js'),
  // Force jose to browser version
  jose: joseWebApiPath,
};

// Configure export conditions to prefer browser over node
// This makes packages with "exports" field use browser variants
config.resolver.unstable_conditionNames = ['browser', 'require', 'react-native'];

// Ensure browser field is preferred in package.json resolution
config.resolver.resolverMainFields = ['react-native', 'browser', 'main'];

// Force jose to use browser version instead of Node version
config.resolver.resolveRequest = (context, moduleName, platform) => {
  // Intercept jose package imports - force browser version
  if (moduleName === 'jose') {
    return {
      filePath: path.join(joseWebApiPath, 'index.js'),
      type: 'sourceFile',
    };
  }

  // Intercept any deep jose imports and redirect to browser
  if (moduleName.startsWith('jose/')) {
    const subpath = moduleName.replace('jose/', '');
    const browserFile = path.join(joseWebApiPath, subpath);

    // Try exact path
    if (fs.existsSync(browserFile)) {
      return { filePath: browserFile, type: 'sourceFile' };
    }
    // Try with .js extension
    if (fs.existsSync(browserFile + '.js')) {
      return { filePath: browserFile + '.js', type: 'sourceFile' };
    }
    // Try index.js
    if (fs.existsSync(path.join(browserFile, 'index.js'))) {
      return { filePath: path.join(browserFile, 'index.js'), type: 'sourceFile' };
    }
    // Fall back to main browser entry
    return { filePath: path.join(joseWebApiPath, 'index.js'), type: 'sourceFile' };
  }

  // Redirect any jose/dist/node imports to browser equivalents
  if (moduleName.includes('jose/dist/node')) {
    // Map node path to browser path
    let browserPath = moduleName
      .replace('/node/esm/', '/webapi/')
      .replace('/node/cjs/', '/webapi/');

    // Get the relative path from jose/dist/webapi
    const relativePath = browserPath.replace(/.*jose\/dist\/webapi\//, '');
    const fullPath = path.join(joseWebApiPath, relativePath);

    // Check if exact file exists
    if (fs.existsSync(fullPath)) {
      return { filePath: fullPath, type: 'sourceFile' };
    }

    // Try with .js extension
    if (fs.existsSync(fullPath + '.js')) {
      return { filePath: fullPath + '.js', type: 'sourceFile' };
    }

    // Fall back to browser index
    return { filePath: path.join(joseWebApiPath, 'index.js'), type: 'sourceFile' };
  }

  // Default resolution
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
