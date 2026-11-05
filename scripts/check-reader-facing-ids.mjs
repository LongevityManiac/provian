#!/usr/bin/env node
/**
 * Product files state the live rule. Internal record keys and ruling
 * attributions belong in the private operator record.
 *
 * Scan every tracked file, including source, tests, generated files and hooks.
 * Frozen evidence retains its pinned bytes; the named founding narratives retain
 * their authorship. Binary blobs are counted separately from UTF-8 text.
 *
 * Third-party license texts are not Provian prose. The open source notices module carries the
 * license files of the app's dependencies verbatim; only its license-text line is set aside, and
 * only while the whole module is byte-identical to what scripts/generate-oss-notices.mjs derives
 * from package-lock.json, the installed packages, ios/Podfile.lock and scripts/oss-notices/. A hand
 * edit, a stale module or a missing install scans the module in full. The license files under
 * scripts/oss-notices/licenses/ are scanned like any other tracked file.
 */
import { readFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OUT as OSS_NOTICES_MODULE, expectedModule as expectedOssNotices } from './generate-oss-notices.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const RECORD_KEY = /\bD-\d{2,}(?:[a-z]|\([a-z\d]+\))?|\bWP(?:-CLK|\d+)(?=\b|_)/;
const ATTRIBUTION = /\b[F]rank\b/;
const RULING_ATTRIBUTION = /\b[F]rank(?:[’']s)?(?:,?\s+)(?:\d{4}-\d{2}-\d{2}|ruling|approval|EOA|Gate)\b|\bapproved by [F]rank\b/;
const NUMBERED_RECORD = /\b[M]ASTER RUN(?: [A-Z]\d+)?\b|\b[Rr]ulings?\s+\d+/i;
const REMOVED_EARNING_PATH = new RegExp([['ref', 'erral'].join(''), ['PROVIAN_', 'REFERRER'].join(''), ['Pending', 'Referrer'].join(''), ['[?&]', 'ref='].join(''), ['/invite', String.raw`\?c=`].join(''), ['/v1/wallet/', 'invite'].join(''), ['human_', 'invites'].join(''), ['recr', 'uit'].join(''), ['human', '[-_ ]invite(?!d)'].join('')].join('|'), 'i');

// Every exception is an exact path and an exact byte hash. A new file cannot
// inherit an exemption from a directory name, and an edit cannot hide in one.
export const FROZEN_ARTIFACTS = Object.freeze({
  "config/integrity/baseline-pins.json": "0fb0079474af5c7102548deff6582bd972a7c4de8113121b7cbe7ec007c758f3",
  "config/integrity/retired-paths.json": "2e96661fcac969b3e615cc2a42efbd3d8b57b56186bda5fb1a900b37c568bfc5",
  "config/integrity/wp-merge-binding.json": "92d9ef7b6e2f25c32aa8808bd321081b60cd8b422d5d006f01035a3faf6cfdf0",
  "contracts/src/ProvianBondPool.sol": "e3fe8422165d6e1520c5e93324f743c042a26d93d5fa1d26e1491c4da2d1ad0b",
  "contracts/src/ProvianCourtV2.sol": "8dc9d054d06fcd71981ba56cb62c5a1daf356413a2d14783a2aa0358ae2a5cdf",
  "contracts/src/ProvianEscrowV4.sol": "12c6d671bc00f1528ae08ac4f1524e1465c7deeef918d74452d4334882c071f6",
  "contracts/src/ProvianPEAnchor.sol": "2ad92d10fa7a178408c07c46bd418b2f8face39f82d3c1e7457d098fac40c3c4",
  "contracts/src/ProvianPVT9.sol": "6fafddefe8c20490a813e13095bb466bccb6dd2b7a7b506c4c9f576497dd8a5d",
  "contracts/src/ProvianPVT9EligibilityVerifier.sol": "dc129c388219e05ca3cf55b80c4f9cd91d6628f2345556a62c8823b2103b8e02",
  "contracts/src/ProvianPoolV3.sol": "52a1643ef6bee5b3c04d5ded9b2c6df3b61482b0b33c4ccd82716a0402606e2e",
  "contracts/src/ProvianPromiseV3.sol": "2cd557fa76f15805f8ac8983541b9cf6543deb00e82b826901fb3158ca091a8b",
  "contracts/src/interfaces/IPVT.sol": "31b60fcf701c94cc472478c62218a2c0e26bdca361b706971289e7ebc42153bb",
  "contracts/test/ProvianPEAnchor.t.sol": "fc2b5263ce63d8cc79487034a2f210a793a7ae66ff60b0aca9f8402fd1577897",
  "docs/audit/pvt-wp0-wp1/pvt-action-policy-matrix.generated.json": "acdd8f592c75ac2b427c0dac87053f12be41fd4646fd84a22c5c13ac9ebd12a7",
  "docs/audit/pvt-wp0-wp1/pvt-launch-capacity-model.generated.json": "9df622ffd8bf3470bcce3ae55a5860dc75f8b5859f3707cfa7a3a9aea2c17967",
  "docs/audit/pvt-wp0-wp1/pvt-policy-approval-manifest.generated.json": "704c1a2d9e555b56d9b4a5803b3f641b0e29e5e3012af0c0c3dc5ae665be6e71",
  "provian-agent-sdk/src/agent-wallet-promotion.test.ts": "1fb38d793c07f5660872e73c7e3c8554e3f4980f94c4487e2d3fd6132d022096",
  "provian-agent-sdk/src/agent-wallet-promotion.ts": "6427104c6358954d9e5029f97122e80ed35764aa6b1ea8e2867b3aceaa43bf0d",
  "provian-agent-sdk/src/durable-private-file.ts": "c7ba23d36d7e3c7f68eb8f6ca113d998f33edeea7dfd4785fb944abf739c9966",
  "provian-agent-sdk/src/input-origins.test.ts": "de4228ef386370e749ab88f9e8f477a8c1ea128a39f4e4580c5099b2fe7dc426",
  "provian-agent-sdk/src/observer/origin-capture.credentials.test.ts": "70144f7701819f837a426f0c003ecbbf8517a208f140f05194ca589bc954b248",
  "provian-agent-sdk/src/scripts/agent-credentials-file.test.ts": "9c4e7c4d36fb0ec65e2b677ed669771148cf8ea0b221cba7508e3d2f7ee5bb76",
  "provian-agent-sdk/src/scripts/agent-credentials-file.ts": "e9aeacbf5f74ae4aeef61f0836c258dc4aa6cb1d51f0d4e75b076b6e1ceb1ed3",
  "provian-agent-sdk/src/scripts/credentials.test.ts": "94f4a2e4c90d6706acd7881b8e04007a2409d783b28dfa1aba11fbcdf73912bd",
  "provian-agent-sdk/src/scripts/credentials.ts": "a533ff505e7b26a86d6533d9bf1ff129b99977bfb7692c7f19ee46f8b6e38136",
  "provian-agent-sdk/src/scripts/pending-device-registration.test.ts": "8a73f65ca8db7578a24bc3b483ea33666531f357c92c1b1c7833ec3a4b1fdc95",
  "provian-agent-sdk/src/scripts/pending-device-registration.ts": "1ee69b26be9d8c69531efee97467ed29dbbc90e11f05c12c5f66de1b1fcfc6c2",
  "provian-agent-sdk/src/scripts/register-device.agentToken.test.ts": "02cbbc3b3b5db33e466674d52d3cb0deefde8bca834a09e2a4f247838208822c",
  "provian-agent-sdk/src/scripts/register-device.otelProfile.test.ts": "09ae037453a746eb24c10bc20a92c43ff4d5586e72906d120a11452d84819837",
  "provian-backend/scripts/generate-pvt-capacity-model.ts": "e96c93e3de87c5ede8d61e0e0b2cee6d1221a5de8df44ae838b50ec41dcfbd11",
  "provian-backend/src/core/agent-bank/escrow.ts": "013f6515529a4b5a0572ceb8620cf43c6ceab9ea6155245fc48a98912c5ca855",
  "provian-backend/src/core/agent-bank/scheduler.ts": "589f3d02e25f2f085ea50df3eca51b9f5624be5543ea777d7a3afba69957ce73",
  "provian-backend/src/core/agent-wallet/proof-of-possession.wave4.test.ts": "f1fa62bda525422a10e9afaf699713cb71437e14591e9b1d512604986494ded2",
  "provian-backend/src/core/attestation/types.ts": "8cfc72889687ebc2de41b39984036c09c35d8350117ef579cb56dd110664fce9",
  "provian-backend/src/core/external-address/challenge.test.ts": "41da976ac51f87ab9f8fee41a2bae09c73f4bac9e8536333f48aaf1a2fff64c2",
  "provian-backend/src/core/external-address/proof-head.test.ts": "ac38d7a1b82e3ce20e4ca8537b7f0ff473b513e4e19e90169897a46bfbf58b09",
  "provian-backend/src/core/external-address/proof-head.ts": "c21bc3146bba868f5dab31ffdba243091102201d503d0cbef2a6b0e1c89a89cf",
  "provian-backend/src/core/external-address/verify.test.ts": "2e0531991d11424071301fbb398ab2d664a095967a531e91ff0145f9b863e7c3",
  "provian-backend/src/core/external-address/verify.ts": "8aada2889379f0061b193e8bd5b9fe4c8b510598f6c6a7c8cc3414e5f9e4d04f",
  "provian-backend/src/core/notifications/pushDispatcher.test.ts": "38b865af573d96d48deb9427672426e97263481a9b1070181b7985fc3c76bb2d",
  "provian-backend/src/core/onchain/economic-constants.ts": "c4419d41a0350dca013b072f8964dd6fd16481e2280526054231fac4efbedef3",
  "provian-backend/src/core/onchain/economic-finality.test.ts": "88b2d681b5e87062c344b3097cab98b6ac059d121a0495e446ba2963eaef95f9",
  "provian-backend/src/core/onchain/prepared-economic-transaction.test.ts": "fc785fefe0259348b8b8ba1873960b5d375af1a8cbedf2101ab2797769a36e4c",
  "provian-backend/src/core/onchain/prepared-economic-transaction.ts": "31f4b91de189ef4c1f7035593069358165df047c03f70ea8eb153c7d92bd787b",
  "provian-backend/src/core/onchain/rpc-provider.test.ts": "d5778b7b7f874e32c2e96a49beb1bd3c558b5cee1e409393abfa2893f45cebd5",
  "provian-backend/src/core/onchain/tx-verifier.pool.test.ts": "1a30c5153559a84e980e88eba6f60be29fac29205c241c63050da2756a47ad4d",
  "provian-backend/src/core/onchain/tx-verifier.test.ts": "6c1928aff871d336034f6540f6b1664766c6d9b027a9c32a5e0401793efaf97b",
  "provian-backend/src/core/provenance/input-origins.test.ts": "17df2e13eb4d29532197fd821958d46855753ff360aed5e6ab9387ab9f3458f4",
  "provian-backend/src/core/pvt/__test-helpers__/armed-genesis-policy.ts": "6b36d1168171e35ed8273fb5c159105de223eea2970e82dca57d14ba3334b2f3",
  "provian-backend/src/core/pvt/__test-helpers__/base-economic-evidence.ts": "f7afc5cf87a03cd173e2a1d5bace0d617160d6dee2ad63dd2aeea7d2fb96dd85",
  "provian-backend/src/core/pvt/anchor-recovery-cli.test.ts": "bc4b58cbd8186f4b88a08c99f6886fe7ca42d392e4d071fb9c76e3258d6de44c",
  "provian-backend/src/core/pvt/anchor-recovery-worker.guardrails.test.ts": "9843ab5d94ee9b92c266b1ca99e7c41a3605bebe8131d51571a1e2595f814ce5",
  "provian-backend/src/core/pvt/anchor-recovery-worker.ts": "9589b9a63b44315c37408e804ae49d43a566a82fab2fc15b27f164a19f3fb49f",
  "provian-backend/src/core/pvt/artifact-novelty-claim.ts": "1ca02d03db929ed13f15f3328663451fce781dece32ccf0c80ff2474b99cdc96",
  "provian-backend/src/core/pvt/beneficiary-routing.test.ts": "489f3383b636ca6b585420f56eaa67e2e534a664ad25c22154abf4c34a3a38ad",
  "provian-backend/src/core/pvt/beneficiary-routing.ts": "3c862404b8c6977012efd088bc70e12534bd9de6e31aa770474353585aa46c95",
  "provian-backend/src/core/pvt/commit-mint-claim.test.ts": "b6593ff78ff52521f7574f7de2531970d92a71047491847d74cecd294f5d5bc3",
  "provian-backend/src/core/pvt/commit-mint-claim.ts": "e18d23e78b95c30c0980e51e33ce9179980520a07cb8e7970f97a841bdc13931",
  "provian-backend/src/core/pvt/deferred-release.test.ts": "98b444c2cd76a0fcb4ad09ca7bc3de44787ac46110beed8bd6b3ab9439fa350f",
  "provian-backend/src/core/pvt/economic-transition-coordination.ts": "26865aa7c2436c974754940d4c9c6e0643aeeb8bfe3a27a06d5d82c1b93503f8",
  "provian-backend/src/core/pvt/epoch-keeper.ts": "570386350ed8a983aff2a709b934a040f05a5cb0dd0a21abe32c27b7bff141fa",
  "provian-backend/src/core/pvt/foundation-allocation.test.ts": "c27130ba72c7da3d65bb937b590098cfcf5e7a007ad81827774cc68dcce6ac31",
  "provian-backend/src/core/pvt/genesis-activation-approval-binding.test.ts": "6049feef222407d1a5c95de02c7237101ae6dc147b92ae773121dadcb4cfe0d2",
  "provian-backend/src/core/pvt/genesis-milestones.external.test.ts": "82a7e84ab6ce0901c9386f081eab78efa2b39c2b5c110df82d55b92f0528f3f1",
  "provian-backend/src/core/pvt/genesis-payout.ts": "d61f7ae0eb20dbcaaeac96faf8dab91a381e043883db92d81d7d0ab51dd3600f",
  "provian-backend/src/core/pvt/inbound-usdc-watcher.external.test.ts": "0d1fe39b56e82cca6b40c1a4adf6010b48f7fa11fe4ad5fbb4a252339325b6b6",
  "provian-backend/src/core/pvt/merkle.ts": "026d5e01ca2c43c5f1ea3fdc2f01e415b3f83208f76642e89c4db3e3c8a9a9ca",
  "provian-backend/src/core/pvt/mint-recipient-resolver.test.ts": "a210d6cdf3330a6973f45ca38596949016b4332972982c88825fba21345c417c",
  "provian-backend/src/core/pvt/mint-recipient-resolver.ts": "90cb6e9641b56a004e9a616235527ba268121c25fcf47ce50479da90a93283e8",
  "provian-backend/src/core/pvt/native-wallet-registration.test.ts": "a0264bf6b3dbe18cc4d73c384de2ef13c01284ceaa6c0d7832cf6bf438c25412",
  "provian-backend/src/core/pvt/policy/__artifacts__/genesis-campaign-policy.json": "63b94b743e39bf96efe8d4c10a5c1fa57c2cc8b6f2b35d71d9b244c55fee13d7",
  "provian-backend/src/core/pvt/policy/__artifacts__/genesis-settlement-approval-manifest.json": "595fe2f4aa42db63a0296f27f9bbff5174cee9d3cb5157f210ccdf6bfae89ca3",
  "provian-backend/src/core/pvt/policy/__fixtures__/approval/fixture-key.pub": "a72ba0f7a468c7c75efd094e3c2a1037a8ed082ec895b53b7c9da0c80cc17562",
  "provian-backend/src/core/pvt/policy/__fixtures__/approval/manifest-a.json": "06c3844c1e844432738fbaab21de1592ee6b8f11a8f3070d04be2e5ae9b83fd4",
  "provian-backend/src/core/pvt/policy/__fixtures__/approval/manifest-a.json.sig": "19b9c06f2a687b520b991caeb7257030a0fb302db5411d656a24cd0c848040ac",
  "provian-backend/src/core/pvt/policy/__fixtures__/approval/manifest-b.json": "fdde77117052990b0abe1c375f6e9e2d5c68c0ec84678b4e9f101c1d1ab71562",
  "provian-backend/src/core/pvt/policy/__fixtures__/approval/manifest-b.json.sig": "1ce730f3b2e05d10ecd4ead18660a618107e47833d86160e581d924f210e134d",
  "provian-backend/src/core/pvt/policy/action-type-syntax.ts": "74a4780e33a7575d64dd6105dde81d136e9cd6cc7eb5edb0def8d82bd39daf54",
  "provian-backend/src/core/pvt/policy/approval-signature.test.ts": "f57abcbcf2c68112a120c120578cbd653bbaeb955ae1f0f9cf69c14f230c89ad",
  "provian-backend/src/core/pvt/policy/approval-signature.ts": "2b0d5714d0607d2ec269662fb49c3b51a8654417cf260fdc48f5f127c3e51212",
  "provian-backend/src/core/pvt/policy/current-approval.test.ts": "05b4478768496e46383f84639408128534a4cabfb3f0aa8a85b1c68439522b41",
  "provian-backend/src/core/pvt/policy/genesis-settlement-authorization.test.ts": "07212ff73cd3c190857ab508b14a60fae61b938811166a02f788d518389bb3db",
  "provian-backend/src/core/pvt/policy/genesis-settlement-authorization.ts": "a2584c81529f6c0c5e5ecb01038ab36177816c0674d37ac647e74c029f686ff3",
  "provian-backend/src/core/pvt/policy/pe-type-catalog.cut-line.json": "64f70b6f544ba14720385554b9d6e2b1cde733ffa8cab6539730203c09030f5c",
  "provian-backend/src/core/pvt/policy/proposed-pvt-cost-catalog.ts": "d1a5844c334077471c939861585770b658654abd75786b110c8617055f6a0049",
  "provian-backend/src/core/pvt/policy/pvt9-approval-manifest.generated.ts": "0512e8b0eb0a73c9d825bbc7744e4807dde7a974a290390c65c312f454956e39",
  "provian-backend/src/core/pvt/policy/rejected-approval-manifests.ts": "73a623b3a3aedc288eeccad25eb182eac92ba6daf200726de3229a0cccaac75f",
  "provian-backend/src/core/pvt/policy/runtime-monetary-policy.test.ts": "4048bc80f72821cb4d38fec39121fade87af0a5ef19aa9b19615c5cb9562d405",
  "provian-backend/src/core/pvt/x402-tx-mint-claim.test.ts": "244326cbd88471c3b0b048355ddbb10eec4ba35d19772977c0b602fa03865a6e",
  "provian-backend/src/device-pe-rate-limiter.test.ts": "344744ee70c4530066c4a5676ab43fb275f928e23a39278f84fb21ef93d27a75",
  "provian-backend/src/firestore-errors.ts": "00090abefc3187ddfc1bfdf4c80e509e14550a20061e4c2fe3f15952f6701ffb",
  "provian-backend/src/mcp/core/crypto.ts": "c4d2cfd13091950520ccf024520a903d5f722d442ca3e9999b1fd118cb5b7b23",
  "provian-backend/src/mcp/core/keccak256.ts": "f5054aada8e46d0f1cd19a02633eee7291b8b66cf42551e97cdde41416795128",
  "provian-backend/src/pe-batch-writer.ts": "65aa2c62906e5afc8682733c6a21bfc7d217ae9f41e1eaa17a892f5549e6b86b",
  "provian-backend/src/pe-chain-validator.ts": "fafe65d2f749e68d7c3586e0f6ed0c22df9e1fbd81ad9786861b03bb641ebc13",
  "provian-backend/src/pvt-accrual.streak.test.ts": "504852d67a08522ac3ce847278141c3a4e228d7f96281622b4af43e1a37a7d22",
  "provian-backend/src/routes/admin-genesis.test.ts": "df51f43bcc59106a14a4f433999c844fac07c4e8fbbf9e268cd29008743495e7",
  "provian-backend/src/routes/agent-wallet-attestation-count.test.ts": "2285f666d1fbc00750e5a7314b3dab779ff4634d897d2a73ddb7327a6bd11380",
  "provian-backend/src/routes/middleware/agent-auth.credential-recovery.test.ts": "7cebab5877a2dc907eccbb09ab60d5b07f17f2a3d51980e9d085354ad85516ef",
  "provian-backend/src/routes/middleware/device-auth-revoke.test.ts": "d6eeedfc2bbbb68888fa18f01366bf29b36da44f2a060b3b36b57014f97c87d0",
  "provian-backend/src/routes/middleware/device-registration-id.ts": "7c78e26b648a49f83530355ba8e1e09659034a54429846c9fb238238ba526b20",
  "provian-backend/src/routes/provisional.claim-resume.test.ts": "645edbb73c490fd246bd47ce12944d93943b69b88f3ee5479d7b354c97ddbe90",
  "provian-backend/src/routes/retired-wallet-creation.test.ts": "c756b7e8b93cb533cc5b2a6c7d3727683ca0a01217f1f87a904dce8bfa8393d0",
  "provian-backend/src/routes/retired-wallet-creation.ts": "66d845394b1e9306027888800f10b9682f3ec4f460be40d176b15dd5b5540b44",
  "provian-mcp/src/agent-wallet-registration.test.ts": "fc87b1e7478d50913d2b97961efd187ab57e9d2a447ee6d9a7f7dbedd0186dd5",
  "provian-mcp/src/agent-wallet-registration.ts": "642b883150d89c1e58cd6832c675521edb48cf84f72aeaf4e56bac778d0e129a",
  "provian-mcp/src/core/crypto.test.ts": "4a047142a98be7cf12584298ff8f268764d1117c0610885a461c39114e8e0a12",
  "provian-mcp/src/core/crypto.ts": "c4d2cfd13091950520ccf024520a903d5f722d442ca3e9999b1fd118cb5b7b23",
  "provian-mcp/src/core/keccak256.ts": "f5054aada8e46d0f1cd19a02633eee7291b8b66cf42551e97cdde41416795128",
  "provian-mcp/src/credentials.test.ts": "c73527686de499161680ec5fbc98eb4f2d7f70f3922a8e3990b374880d174704",
  "provian-mcp/src/credentials.ts": "88e66cbedb59cd7d806f99a729cce77b754f656c109c541ca6c6904c0ef06b0d",
  "provian-mcp/src/device-credentials.ts": "99b6cd1a819b5174118b2e6dd4b69e2453e0f4d29df854ebc4fa872bab023bf1",
  "provian-mcp/src/eip191.ts": "0cd0fa72a6c3a452e95720925ff5d829044740bf545e53fd035419cc3283ce46",
  "provian-mcp/src/index.ts": "2fbf953581e4716a803ad46ecdf56e5708eba875bed0098253ec7b12b28a6312",
  "provian-mcp/tsconfig.json": "5a0cc12f0713ea43fdf23db7ebaef3d87f3425bcab57600f2c6b5223a678434f",
  "provian-se-sign/Package.swift": "3a6c5edb462acd0e1ea3ce3428a03718b1761119fce63f11a4cbe0f334cfb96b",
  "provian-se-sign/Sources/main.swift": "891fc3a2a5b7a58d9caa34a5c1dc4d5bb1d72cbf1cb940a61a615ec61e98907c",
  "scripts/check-mcp-core-mirror.sh": "09503a26bdcbbe5b3ed974b5214c549f68d85980c7860c16a21d8f1f06fd2d88",
  "scripts/sync-mcp-core.sh": "693eaeda3b8d155d0a6e43fbeea26543632738a5501fc7b098577412da510fff"
});
export const FOUNDING_NARRATIVES = new Set([
  "NETWORK_CONSTITUTION.md",
  "provian-website/public/docs-md/founding-statement.md",
  "provian-website/public/llms-full.post-genesis.txt",
  "provian-website/public/llms-full.txt",
  "provian-website/public/llms.post-genesis.txt",
  "provian-website/public/llms.txt",
  "provian-website/src/app/about/page.tsx",
  "provian-website/src/app/atlas/page.tsx",
  "reference/Provian_Founding_Statement_v16.md"
]);

const LICENSE_TEXTS_LINE = 'export const OSS_LICENSE_TEXTS: readonly string[] = ';

/** The open source notices module with its license-text line blanked, only when `expected` matches it byte for byte. */
export function withoutVerifiedLicenseTexts(file, decoded, expected) {
  if (file !== OSS_NOTICES_MODULE || typeof expected !== 'string' || decoded !== expected) return decoded;
  return decoded.split('\n').map((line) => (line.startsWith(LICENSE_TEXTS_LINE) ? '' : line)).join('\n');
}

function expectedOssNoticesModule() {
  try { return expectedOssNotices(ROOT).next; } catch { return null; }
}

function trackedFiles(rev) {
  const args = rev ? ['ls-tree', '-r', '--name-only', '-z', rev] : ['ls-files', '-z'];
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).split('\0').filter(Boolean);
}

export function readerFacingFiles(rev) {
  return trackedFiles(rev).filter((f) => !Object.hasOwn(FROZEN_ARTIFACTS, f) && !FOUNDING_NARRATIVES.has(f));
}

function readBytes(f, rev) {
  return rev
    ? execFileSync('git', ['show', `${rev}:${f}`], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 })
    : readFileSync(resolve(ROOT, f));
}

export function findIds(files, read = (f) => readBytes(f).toString('utf8'), allowFoundingName = false) {
  if (files.length === 0) throw new Error('internal-record check refuses an empty population');
  const hits = [];
  for (const f of files) {
    read(f).split('\n').forEach((line, i) => {
      const key = line.match(RECORD_KEY);
      const attribution = line.match(RULING_ATTRIBUTION) || (!allowFoundingName && line.match(ATTRIBUTION));
      const record = line.match(NUMBERED_RECORD);
      if (REMOVED_EARNING_PATH.test(line)) hits.push(`${f}:${i + 1}: removed earning path`);
      if (key) hits.push(`${f}:${i + 1}: internal record key ${key[0]}`);
      if (record) hits.push(`${f}:${i + 1}: numbered internal record`);
      if (attribution) hits.push(`${f}:${i + 1}: ruling attribution`);
    });
  }
  return hits;
}

export function decodeTrackedText(file, bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    // Only recognized binary formats can bypass text decoding. A corrupt byte
    // in a source file must not turn the entire file into an exemption.
    const extension = extname(file).toLowerCase();
    const prefix = bytes.subarray(0, 12);
    const binary = (extension === '.png' && prefix.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
      || (['.jpg', '.jpeg', '.png'].includes(extension) && prefix.subarray(0, 3).equals(Buffer.from([255, 216, 255])))
      || (extension === '.webp' && prefix.toString('ascii', 0, 4) === 'RIFF' && prefix.toString('ascii', 8, 12) === 'WEBP')
      || (extension === '.mp4' && prefix.toString('ascii', 4, 8) === 'ftyp')
      || (extension === '.jar' && prefix.subarray(0, 4).equals(Buffer.from([80, 75, 3, 4])));
    if (binary) return null;
    throw new Error(`${file}: malformed UTF-8 in a tracked text or unrecognized binary file`);
  }
}

function binaryInvariantHits(file, bytes) {
  // The literal decision/name grep invariants include compressed media bytes.
  // Inspect those bytes without letting invalid UTF-8 erase ASCII matches.
  const raw = bytes.toString('latin1');
  const hits = [];
  if (/\bD-\d{2,3}\b/.test(raw)) hits.push(`${file}: decision key in binary bytes`);
  if (ATTRIBUTION.test(raw)) hits.push(`${file}: attribution in binary bytes`);
  if (REMOVED_EARNING_PATH.test(raw)) hits.push(`${file}: removed earning path in binary bytes`);
  return hits;
}

export function checkTree(rev) {
  const all = trackedFiles(rev);
  if (all.length === 0) throw new Error('internal-record check refuses an empty tracked tree');
  const text = new Map();
  const hits = Object.keys(FROZEN_ARTIFACTS).filter((f) => !all.includes(f)).map((f) => `${f}: frozen artifact missing from tracked tree`);
  let frozen = 0;
  let narrative = 0;
  let binary = 0;
  let gitlinks = 0;
  for (const f of all) {
    // A submodule entry has no file bytes in this repository.
    if (!rev && statSync(resolve(ROOT, f)).isDirectory()) { gitlinks += 1; continue; }
    if (rev && execFileSync('git', ['ls-tree', rev, '--', f], { cwd: ROOT, encoding: 'utf8' }).startsWith('160000 ')) {
      gitlinks += 1; continue;
    }
    const bytes = readBytes(f, rev);
    if (Object.hasOwn(FROZEN_ARTIFACTS, f)) {
      frozen += 1;
      if (createHash('sha256').update(bytes).digest('hex') !== FROZEN_ARTIFACTS[f]) hits.push(`${f}: frozen bytes changed`);
      continue;
    }
    if (FOUNDING_NARRATIVES.has(f)) { narrative += 1; hits.push(...findIds([f], () => bytes.toString('utf8'), true)); continue; }
    // A NUL cannot hide a record in otherwise valid UTF-8 text.
    const decoded = decodeTrackedText(f, bytes);
    if (decoded === null) { binary += 1; hits.push(...binaryInvariantHits(f, bytes)); }
    else text.set(f, f === OSS_NOTICES_MODULE ? withoutVerifiedLicenseTexts(f, decoded, expectedOssNoticesModule()) : decoded);

  }
  hits.push(...findIds([...text.keys()], (f) => text.get(f)));
  return { tracked: all.length, scanned: text.size, frozen, narrative, binary, gitlinks, hits };
}

function selfTest() {
  const key = ['D', '987'].join('-');
  const name = ['Fr', 'ank'].join('');
  const samples = {
    'src/guard-control.ts': `// ${key}: a planted record key\n`,
    'scripts/guard-control.sh': `# ${name} 2099-01-01: a planted attribution\n`,
    'tests/guard-control.ts': `describe('${['WP', '99'].join('')} regression', () => {});\n`,
    'docs/record-control.md': `${['Ru', 'ling'].join('')} 9: planted numbered record\n`,
    'docs/clean.md': 'The policy setter schedules changes prospectively.\n',
  };
  const hits = findIds(Object.keys(samples), (f) => samples[f]);
  if (hits.length !== 4 || !hits.some((h) => h.startsWith('src/guard-control.ts:1:'))
    || !hits.some((h) => h.startsWith('scripts/guard-control.sh:1:'))
    || !hits.some((h) => h.startsWith('tests/guard-control.ts:1:'))) {
    throw new Error(`self-test: planted record key or attribution escaped: ${hits}`);
  }
  const story = `The founder ${name} works with Atlas.`;
  if (findIds(['narrative.md'], () => story, true).length !== 0
    || findIds(['narrative.md'], () => `${name}'s ruling: do work`, true).length !== 1
    || findIds(['nul-control.md'], () => `\0${key}`).length !== 1) {
    throw new Error('self-test: a narrative attribution or NUL escaped');
  }
  let emptyRefused = false;
  try { findIds([], () => 'clean'); } catch { emptyRefused = true; }
  if (!emptyRefused) throw new Error('self-test: empty population passed');
  let malformedRefused = false;
  try { decodeTrackedText('docs/control.md', Buffer.concat([Buffer.from([255]), Buffer.from(key)])); }
  catch { malformedRefused = true; }
  if (!malformedRefused
    || findIds(['src/nul.ts'], () => decodeTrackedText('src/nul.ts', Buffer.from(`\0${key}`))).length !== 1
    || decodeTrackedText('image.png', Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 255])) !== null) {
    throw new Error('self-test: malformed source, NUL source or binary format classification failed');
  }
  if (binaryInvariantHits('image.png', Buffer.concat([Buffer.from([137, 80, 78, 71]), Buffer.from(` ${key} ${name} `)])).length !== 2) {
    throw new Error('self-test: binary decision/name invariant escaped');
  }
  if (findIds(['src/removed-control.ts'], () => ['ref', 'erral'].join('')).length !== 1
    || findIds(['docs/removed-control.md'], () => ['REF', 'ERRAL'].join(''), true).length !== 1) throw new Error('self-test: removed earning path escaped');
  for (const value of [['/v1/wallet/', 'invite'].join(''), ['human_', 'invites'].join(''), ['recr', 'uiter'].join(''), ['HUMAN_', 'INVITE_CODE'].join(''), ['routes/human', '-invite.ts'].join('')]) {
    if (findIds(['src/removed-control.ts'], () => value).length !== 1) throw new Error('self-test: removed endpoint or collection escaped');
  }
  const licenseLine = `${LICENSE_TEXTS_LINE}${JSON.stringify([`Copyright ${name}`])};`;
  const notices = `// generated\n${licenseLine}\n`;
  if (findIds([OSS_NOTICES_MODULE], () => withoutVerifiedLicenseTexts(OSS_NOTICES_MODULE, notices, notices)).length !== 0
    || findIds([OSS_NOTICES_MODULE], () => withoutVerifiedLicenseTexts(OSS_NOTICES_MODULE, notices, `${notices} `)).length !== 1
    || findIds([OSS_NOTICES_MODULE], () => withoutVerifiedLicenseTexts(OSS_NOTICES_MODULE, notices, null)).length !== 1
    || findIds(['src/other.ts'], () => withoutVerifiedLicenseTexts('src/other.ts', notices, notices)).length !== 1
    || findIds([OSS_NOTICES_MODULE], () => withoutVerifiedLicenseTexts(OSS_NOTICES_MODULE, `// ${key}\n${licenseLine}\n`, `// ${key}\n${licenseLine}\n`)).length !== 1) {
    throw new Error('self-test: third-party license texts were set aside without verification, or a planted key beside them escaped');
  }
  const files = readerFacingFiles();
  for (const must of ['package.json', 'src/core/provenance/types.ts', 'provian-backend/src/server.ts',
    'provian-agent-sdk/src/observer/self-update.ts', '.githooks/pre-push', 'scripts/check-reader-facing-ids.mjs']) {
    if (!files.includes(must)) throw new Error(`self-test: tracked-tree population misses ${must}`);
  }
  console.log(`reader-facing-ids self-test: ok; planted decision key, work-package key and attribution caught; empty population refused; license texts set aside only when verified; ${files.length} tracked paths in scope`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.includes('--self-test')) selfTest();
    const index = process.argv.indexOf('--rev');
    if (index >= 0 && !process.argv[index + 1]) throw new Error('--rev requires a revision');
    const result = checkTree(index >= 0 ? process.argv[index + 1] : undefined);
    console.log(`reader-facing-ids: ${result.scanned} text files scanned, ${result.frozen} byte-pinned, ${result.narrative} founding narratives, ${result.binary} binary blobs, ${result.gitlinks} submodules (${result.tracked} tracked)`);
    if (result.hits.length) {
      console.error(`reader-facing-ids: ${result.hits.length} violation(s):\n${result.hits.join('\n')}`);
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(`reader-facing-ids: refusing: ${error.message}`);
    process.exitCode = 1;
  }
}
