module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/*.test.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  // Workstream 2: BigInt-using tests need a serializer polyfill so jest-worker
  // can ship test results back to the main process.
  setupFiles: ['<rootDir>/jest.setup.js'],
};
