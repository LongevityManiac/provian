import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Mirror the TS paths alias so vitest can resolve @provian/agent-sdk during
// unit tests. The file-local workspace link in package.json drives
// production resolution. Unit tests load SDK source and its synthetic DNS fixture;
// production remains built from the package's dist entry and actual DNS.
export default defineConfig({
  test: { setupFiles: ['../provian-agent-sdk/vitest.setup.ts'] },
  resolve: {
    alias: {
      '@provian/agent-sdk': resolve(__dirname, '../provian-agent-sdk/src/index.ts'),
    },
  },
});
