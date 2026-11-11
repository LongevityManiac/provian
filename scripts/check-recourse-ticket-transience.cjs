// Local Anvil proof across actual top-level transactions. Uses only Anvil's
// unlocked public test accounts; refuses every non-loopback RPC target.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { JsonRpcProvider, ContractFactory, getBytes, sha256, toUtf8Bytes, zeroPadValue, toBeHex } = require('ethers');
const root = path.resolve(__dirname, '..');
require(path.join(root, 'provian-backend/node_modules/ts-node')).register({
  transpileOnly: true, project: path.join(root, 'provian-agent-sdk/tsconfig.json'),
});
const { membershipIssuanceSigningHash } = require(path.join(root, 'provian-agent-sdk/src/recourse-issuance-ticket.ts'));
const url = new URL(process.env.RECOURSE_TEST_RPC || 'http://127.0.0.1:18547');
if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password) throw Error('local_test_rpc_required');
const hash = text => sha256(toUtf8Bytes(text));
const h = number => zeroPadValue(toBeHex(number), 32);
async function main() {
  const provider = new JsonRpcProvider(url.href);
  try {
    const client = await provider.send('web3_clientVersion', []);
    if (!String(client).toLowerCase().includes('anvil')) throw Error('anvil_required');
    const signer = await provider.getSigner(0);
    const deploy = async (name, args) => {
      const artifact = JSON.parse(fs.readFileSync(path.join(root, `contracts/out/RecourseIssuanceTickets.t.sol/${name}.json`)));
      const contract = await new ContractFactory(artifact.abi, artifact.bytecode.object, signer).deploy(...args);
      await contract.waitForDeployment(); return contract;
    };
    const kernel = await deploy('TicketKernelMock', []), adapter = await deploy('TicketAdapterMock', []);
    const pool = await deploy('TicketPoolHarness', [await kernel.getAddress(), await adapter.getAddress(), await signer.getAddress()]);
    const account = (await provider.getSigner(1)).address;
    await (await pool.consent(account, true, 1)).wait();
    const context = [h(1), 0, 1, hash('mint rule'), hash('exact kernel settlement'), 1, 100, hash('signed rule')];
    const tickets = [[account, 10000, 9900, 100, 1, true]], mints = [[account, 10000, 9900]];
    const domain = { chainId: String((await provider.getNetwork()).chainId), pointer: '0x000000000000000000000000000000000000007b',
      kernel: (await kernel.getAddress()).toLowerCase(), pool: (await pool.getAddress()).toLowerCase() };
    const contextObject = { batchId: h(1), lane: 0, epoch: '1', policyHash: context[3], settlementDigest: context[4],
      revision: '1', month: '100', membershipRuleHash: context[7] };
    const ticketObjects = [{ account: account.toLowerCase(), gross: '10000', contributor: '9900', contribution: '100',
      consentNonce: '1', protectedMember: true }];
    const signature = await signer.signMessage(getBytes(membershipIssuanceSigningHash(domain, contextObject, ticketObjects)));
    await (await adapter.installOnly(await pool.getAddress(), context, tickets, signature)).wait();
    await assert.rejects(kernel.mintBatch.estimateGas(await pool.getAddress(), h(1), context[4], mints));
    assert.equal(await kernel.total(), 0n);
    assert.equal(await pool.contributions(), 0n);
    // A fresh atomic install/settle/finish succeeds with the identical ticket.
    await (await adapter.settle(await pool.getAddress(), context, tickets, signature, mints, context[4])).wait();
    assert.equal(await kernel.total(), 10000n);
    assert.equal(await kernel.balance(account), 9800n);
    assert.equal(await kernel.balance(await pool.getAddress()), 100n);
    await assert.rejects(kernel.mintBatch.estimateGas(await pool.getAddress(), h(2), context[4], mints));
    await assert.rejects(adapter.cancel.estimateGas(await pool.getAddress(), h(1), 1));
    console.log('Ticket transience: two separate transactions refuse stale context; atomic settlement passes; settled cancellation refuses.');
  } finally { provider.destroy(); }
}
main().catch(error => { console.error(error.shortMessage || error.message); process.exitCode = 1; });
