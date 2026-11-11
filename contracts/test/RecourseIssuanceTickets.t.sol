// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {Test} from "forge-std/Test.sol";
import {RecourseIssuanceTickets} from "../src/RecourseIssuanceTickets.sol";

contract TicketKernelMock {
    struct Mint { address account; uint256 gross; uint256 contributor; }
    mapping(bytes32 => bytes32) public settledDigest;
    mapping(address => uint256) public balance;
    uint256 public total;
    function mintBatch(TicketPoolHarness pool, bytes32 batch, bytes32 digest, Mint[] calldata mints) external {
        require(settledDigest[batch] == bytes32(0), "duplicate");
        for (uint256 i; i < mints.length; ++i) {
            Mint calldata m = mints[i]; uint256 contribution = pool.consume(m.account, m.gross, m.contributor);
            balance[m.account] += m.contributor - contribution; balance[address(pool)] += contribution;
            balance[address(0xfee)] += m.gross - m.contributor; total += m.gross;
        }
        settledDigest[batch] = digest;
    }
}
contract TicketAdapterMock {
    function installOnly(TicketPoolHarness pool, RecourseIssuanceTickets.IssuanceContext calldata context,
        RecourseIssuanceTickets.IssuanceTicket[] calldata tickets, bytes calldata signature) external {
        pool.installIssuanceTickets(context, tickets, signature);
    }
    function settle(TicketPoolHarness pool, RecourseIssuanceTickets.IssuanceContext calldata context,
        RecourseIssuanceTickets.IssuanceTicket[] calldata tickets, bytes calldata signature,
        TicketKernelMock.Mint[] calldata mints, bytes32 actualDigest) external {
        pool.installIssuanceTickets(context, tickets, signature);
        pool.kernel().mintBatch(pool, context.batchId, actualDigest, mints);
        pool.finishIssuanceTickets(context.batchId);
    }
    function cancel(TicketPoolHarness pool, bytes32 batch, uint256 revision) external { pool.cancelIssuanceBatch(batch, revision); }
}
contract TicketPoolHarness is RecourseIssuanceTickets {
    TicketKernelMock public immutable kernel;
    TicketAdapterMock public immutable adapter;
    address public immutable attestor;
    mapping(address => bool) public joined;
    mapping(address => uint256) public nonce;
    uint256 public contributions;
    uint16 public rate = 100;
    bool public active = true;
    constructor(TicketKernelMock k, TicketAdapterMock a, address signer) { kernel = k; adapter = a; attestor = signer; }
    function consent(address account, bool value, uint256 n) external { joined[account] = value; nonce[account] = n; }
    function setRate(uint16 value) external { rate = value; }
    function retire() external { active = false; }
    function consume(address account, uint256 gross, uint256 contributor) external returns (uint256) { return _consumeIssuanceTicket(account, gross, contributor); }
    function _issuanceDomain() internal view override returns (address, address, address) { return (address(123), address(kernel), address(adapter)); }
    function _issuanceAttestor() internal view override returns (address) { return attestor; }
    function _issuanceCurrent(uint256 revision) internal view override { require(active && revision == 1, "retired"); }
    function _issuanceMonth() internal pure override returns (uint256) { return 100; }
    function _issuanceRule(uint256) internal view override returns (bytes32, uint16) { return (sha256("signed rule"), rate); }
    function _issuanceConsent(address account) internal view override returns (bool, uint256) { return (joined[account], nonce[account]); }
    function _issuanceBatchRecord(bytes32 batch) internal view override returns (bool, bytes32) {
        bytes32 digest = kernel.settledDigest(batch); return (digest != bytes32(0), digest);
    }
    function _creditTicketContribution(address, uint256 amount) internal override { contributions += amount; }
}
contract RecourseIssuanceTicketsTest is Test {
    uint256 constant ATTESTOR = 0x123456;
    TicketPoolHarness pool; TicketKernelMock kernel; TicketAdapterMock adapter;
    address constant ALICE = address(0xa11ce); address constant BOB = address(0xb0b);
    function setUp() public {
        kernel = new TicketKernelMock(); adapter = new TicketAdapterMock();
        pool = new TicketPoolHarness(kernel, adapter, vm.addr(ATTESTOR));
        pool.consent(ALICE, true, 1); pool.consent(BOB, true, 1);
    }
    function context() private pure returns (RecourseIssuanceTickets.IssuanceContext memory) {
        return RecourseIssuanceTickets.IssuanceContext(bytes32(uint256(1)), 0, 1, sha256("mint rule"),
            sha256("exact kernel settlement"), 1, 100, sha256("signed rule"));
    }
    function tickets() private pure returns (RecourseIssuanceTickets.IssuanceTicket[] memory t) {
        t = new RecourseIssuanceTickets.IssuanceTicket[](2);
        t[0] = RecourseIssuanceTickets.IssuanceTicket(ALICE, 199, 198, 1, 1, true);
        t[1] = RecourseIssuanceTickets.IssuanceTicket(BOB, 1, 1, 1, 1, true);
    }
    function mints(RecourseIssuanceTickets.IssuanceTicket[] memory t) private pure returns (TicketKernelMock.Mint[] memory m) {
        m = new TicketKernelMock.Mint[](t.length);
        for (uint256 i; i < t.length; ++i) m[i] = TicketKernelMock.Mint(t[i].account, t[i].gross, t[i].contributor);
    }
    function sign(RecourseIssuanceTickets.IssuanceContext memory c, RecourseIssuanceTickets.IssuanceTicket[] memory t) private returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ATTESTOR, pool.issuanceDigest(c, t)); return abi.encodePacked(r, s, v);
    }
    function settle(RecourseIssuanceTickets.IssuanceContext memory c, RecourseIssuanceTickets.IssuanceTicket[] memory t) private {
        adapter.settle(pool, c, t, sign(c, t), mints(t), c.settlementDigest);
    }
    function reject(RecourseIssuanceTickets.IssuanceContext memory c, RecourseIssuanceTickets.IssuanceTicket[] memory t) private {
        bytes memory signature = sign(c, t); TicketKernelMock.Mint[] memory m = mints(t);
        vm.expectRevert(); adapter.settle(pool, c, t, signature, m, c.settlementDigest);
    }
    function testExactCombinedRoundingPreservesGrossSupplyAndProtocolAllocation() public {
        settle(context(), tickets());
        assertEq(kernel.total(), 200); assertEq(kernel.balance(ALICE), 197); assertEq(kernel.balance(BOB), 0);
        assertEq(kernel.balance(address(0xfee)), 1); assertEq(kernel.balance(address(pool)), 2); assertEq(pool.contributions(), 2);
        vm.expectRevert(); pool.consume(ALICE, 199, 198);
        vm.prank(address(kernel)); vm.expectRevert(); pool.consume(ALICE, 199, 198); // finished context cannot replay
    }
    function testOnlyAdapterInstallsAndOnlyKernelConsumes() public {
        RecourseIssuanceTickets.IssuanceContext memory c = context(); RecourseIssuanceTickets.IssuanceTicket[] memory t = tickets();
        bytes memory signature = sign(c, t);
        vm.expectRevert(); pool.installIssuanceTickets(c, t, signature);
        vm.prank(address(adapter)); pool.installIssuanceTickets(c, t, signature);
        vm.expectRevert(); pool.consume(ALICE, 199, 198);
        vm.expectRevert(); pool.finishIssuanceTickets(c.batchId);
    }
    function testMissingExtraOrWrongActualMintRevertsWholeBatch() public {
        RecourseIssuanceTickets.IssuanceContext memory c = context(); RecourseIssuanceTickets.IssuanceTicket[] memory t = tickets();
        bytes memory signature = sign(c, t); TicketKernelMock.Mint[] memory m = mints(t);
        m[1].gross = 2; vm.expectRevert(); adapter.settle(pool, c, t, signature, m, c.settlementDigest);
        m = mints(t); m[1].contributor = 0; vm.expectRevert(); adapter.settle(pool, c, t, signature, m, c.settlementDigest);
        m = mints(t); m[1].account = ALICE; vm.expectRevert(); adapter.settle(pool, c, t, signature, m, c.settlementDigest);
        m = new TicketKernelMock.Mint[](1); m[0] = TicketKernelMock.Mint(ALICE, 199, 198);
        vm.expectRevert(); adapter.settle(pool, c, t, signature, m, c.settlementDigest);
        m = new TicketKernelMock.Mint[](3); m[0] = TicketKernelMock.Mint(ALICE, 199, 198);
        m[1] = TicketKernelMock.Mint(BOB, 1, 1); m[2] = m[1];
        vm.expectRevert(); adapter.settle(pool, c, t, signature, m, c.settlementDigest);
        assertEq(kernel.total(), 0); assertEq(pool.contributions(), 0); assertEq(kernel.balance(ALICE), 0);
    }
    function testWrongKernelDigestCannotCompleteOrLeaveAReusableContext() public {
        RecourseIssuanceTickets.IssuanceContext memory c = context(); RecourseIssuanceTickets.IssuanceTicket[] memory t = tickets();
        bytes memory signature = sign(c, t); TicketKernelMock.Mint[] memory m = mints(t);
        bytes32 wrongDigest = sha256("different claims");
        vm.expectRevert(); adapter.settle(pool, c, t, signature, m, wrongDigest);
        assertEq(kernel.total(), 0); settle(c, t);
    }
    function testNonmemberAndLapsedTicketsCannotDivertEvenWithAttestorSignature() public {
        RecourseIssuanceTickets.IssuanceTicket[] memory t = tickets();
        t[0].protectedMember = false; reject(context(), t);
        t[0].contribution = 0; pool.consent(ALICE, false, 1); settle(context(), t);
        assertEq(kernel.balance(ALICE), 198);
    }
    function testStaleConsentOrUnjoinedProtectedRecipientRefuses() public {
        pool.consent(ALICE, true, 2); reject(context(), tickets());
        pool.consent(ALICE, false, 1); reject(context(), tickets());
        assertEq(kernel.total(), 0);
    }
    function testAttestorCannotChooseMoreThanExactFloorOrCeilOrTakeProtocolAllocations() public {
        RecourseIssuanceTickets.IssuanceTicket[] memory t = tickets();
        t[0].contribution = 3; reject(context(), t); t[0].contribution = 0; reject(context(), t);
        t = tickets(); t[1].gross = 100; t[1].contributor = 99; t[1].contribution = 2; reject(context(), t);
        pool.setRate(10000); t[0].contribution = 198; t[1].contribution = 99; settle(context(), t);
        assertEq(kernel.balance(address(0xfee)), 2); assertEq(kernel.balance(address(pool)), 297);
    }
    function testCancelledBatchCannotInstallAndSettledBatchCannotProduceCancellationProof() public {
        RecourseIssuanceTickets.IssuanceContext memory c = context();
        vm.expectRevert(); pool.cancelIssuanceBatch(c.batchId, 1);
        adapter.cancel(pool, c.batchId, 1); reject(c, tickets());
        c.batchId = bytes32(uint256(2)); settle(c, tickets());
        vm.expectRevert(); adapter.cancel(pool, c.batchId, 1);
    }
    function testCompletedContextCannotBeReinstalledForAnotherSameShapedBatch() public {
        RecourseIssuanceTickets.IssuanceContext memory c = context();
        RecourseIssuanceTickets.IssuanceTicket[] memory t = tickets(); bytes memory signature = sign(c, t);
        settle(c, t);
        vm.prank(address(adapter)); vm.expectRevert(); pool.installIssuanceTickets(c, t, signature);
        assertEq(kernel.total(), 200); assertEq(pool.contributions(), 2);
    }
    function testWrongMonthRuleRevisionOrSignerCannotInstall() public {
        RecourseIssuanceTickets.IssuanceContext memory c = context(); RecourseIssuanceTickets.IssuanceTicket[] memory t = tickets();
        c.month++; reject(c, t); c.month--;
        c.membershipRuleHash = sha256("wrong rule"); reject(c, t); c.membershipRuleHash = context().membershipRuleHash;
        c.revision++; reject(c, t); c.revision--;
        bytes memory signature = sign(c, t); signature[0] ^= bytes1(uint8(1));
        TicketKernelMock.Mint[] memory m = mints(t);
        vm.expectRevert(); adapter.settle(pool, c, t, signature, m, c.settlementDigest);
        pool.retire(); reject(c, t);
    }
    function testFuzzContributionBoundNeverOverflows(uint256 gross, uint16 bps) public {
        bps = uint16(bound(bps, 0, 10000)); pool.setRate(bps);
        RecourseIssuanceTickets.IssuanceTicket[] memory t = new RecourseIssuanceTickets.IssuanceTicket[](1);
        uint256 floor = gross / 10000 * bps + (gross % 10000) * bps / 10000;
        t[0] = RecourseIssuanceTickets.IssuanceTicket(ALICE, gross, gross, floor, 1, true);
        settle(context(), t); assertEq(kernel.balance(address(pool)), floor); assertEq(kernel.total(), gross);
    }
}
