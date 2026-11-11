// Cross-language contract fixture: execute the actual SDK serializer, not a
// second copy of the ABI or hash algorithm declared by a Solidity test.
const path = require('node:path');
const root = path.resolve(__dirname, '../../..');
require(path.join(root, 'provian-backend/node_modules/ts-node')).register({
  transpileOnly: true, project: path.join(root, 'provian-agent-sdk/tsconfig.json'),
});
const sdk = require(path.join(root, 'provian-agent-sdk/src/recourse-membership-authorization.ts'));
const [mode, chainId, pointer, kernel, pool, payload] = process.argv.slice(2);
const domain = { chainId, pointer, kernel, pool };
const result = mode === 'consent' ? sdk.addressMembershipDigest(domain, JSON.parse(payload))
  : mode === 'debit' ? sdk.exactMembershipDebitDigest(domain, JSON.parse(payload)) : null;
if (!result) throw Error('invalid_fixture_mode');
process.stdout.write(result);
