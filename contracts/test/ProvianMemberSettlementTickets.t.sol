// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {Test} from "forge-std/Test.sol";
import {ProvianPVT9} from "../src/ProvianPVT9.sol";
import {ProvianProtocolPointer} from "../src/ProvianProtocolPointer.sol";
import {ProvianHashAccount} from "../src/ProvianHashAccount.sol";
import {ProvianMemberSettlement, IMemberContributionCollector} from "../src/ProvianMemberSettlement.sol";
import {RecourseIssuanceTickets} from "../src/RecourseIssuanceTickets.sol";

contract EnvelopeKernelMock {
    mapping(bytes32 => ProvianPVT9.BatchRecord) private batches;
    mapping(address => uint256) public balanceOf;
    uint256 public totalSupply;
    EnvelopePoolMock public pool;
    address public adapter;
    function configure(EnvelopePoolMock p, address a) external { require(address(pool) == address(0)); pool = p; adapter = a; }
    function getBatchRecord(bytes32 id) external view returns (ProvianPVT9.BatchRecord memory) { return batches[id]; }
    function settleStandardPEBatch(bytes32 batch, uint64 epoch, bytes32 rule, uint256 start, uint256 end,
        ProvianPVT9.StandardRecipient[] calldata recipients, ProvianPVT9.StandardPEClaim[] calldata claims) external {
        _standard(batch, epoch, rule, start, end, recipients, claims);
    }
    // A constructible unknown-selector control: if the adapter drops its
    // whitelist, this otherwise valid entry point can mint and record a batch.
    function unapprovedSettlement(bytes32 batch, uint64 epoch, bytes32 rule, uint256 start, uint256 end,
        ProvianPVT9.StandardRecipient[] calldata recipients, ProvianPVT9.StandardPEClaim[] calldata claims) external {
        _standard(batch, epoch, rule, start, end, recipients, claims);
    }
    function _standard(bytes32 batch, uint64 epoch, bytes32 rule, uint256 start, uint256 end,
        ProvianPVT9.StandardRecipient[] calldata recipients, ProvianPVT9.StandardPEClaim[] calldata claims) private {
        require(msg.sender == adapter && !batches[batch].settled);
        uint256 cursor;
        for (uint256 i; i < recipients.length; ++i) {
            uint256 gross;
            for (uint256 j; j < recipients[i].claimCount; ++j) gross += claims[cursor++].recordPointsAtomic;
            _mint(recipients[i].contributor, gross);
        }
        _record(batch, epoch, rule, start, end, ProvianPVT9.SettlementLane.StandardPE);
    }
    function settleGenesisPEBatch(bytes32 batch, uint64 epoch, bytes32 rule, uint256 start, uint256 end,
        ProvianPVT9.GenesisRecipient[] calldata recipients, ProvianPVT9.GenesisPEClaim[] calldata claims) external {
        require(msg.sender == adapter && !batches[batch].settled);
        uint256 cursor;
        for (uint256 i; i < recipients.length; ++i) {
            uint256 gross;
            for (uint256 j; j < recipients[i].claimCount; ++j) gross += claims[cursor++].reservedGrossAtomic;
            _mint(recipients[i].contributor, gross);
        }
        _record(batch, epoch, rule, start, end, ProvianPVT9.SettlementLane.GenesisPE);
    }
    function _mint(address account, uint256 gross) private {
        uint256 contributor = gross - 2 * (gross * 50 / 10000);
        uint256 diverted = pool.divertIssuance(account, gross, contributor);
        balanceOf[account] += contributor - diverted; balanceOf[address(pool)] += diverted;
        balanceOf[address(0xfee)] += gross - contributor; totalSupply += gross;
    }
    function _record(bytes32 batch, uint64 epoch, bytes32 rule, uint256 start, uint256 end, ProvianPVT9.SettlementLane lane) private {
        ProvianPVT9.BatchRecord storage r = batches[batch]; r.settled = true; r.epoch = epoch; r.policyHash = rule;
        r.finalizedCursorStart = start; r.finalizedCursorEnd = end; r.lane = lane; r.settlementDigest = keccak256(msg.data);
    }
    function arbitraryTransfer(address to, uint256 amount) external { balanceOf[to] += amount; totalSupply += amount; }
}
contract EnvelopePoolMock is RecourseIssuanceTickets, IMemberContributionCollector {
    EnvelopeKernelMock public immutable kernel; ProvianProtocolPointer public immutable pointer;
    address public immutable attestor; ProvianMemberSettlement public adapter; uint256 public contributions;
    constructor(EnvelopeKernelMock k, ProvianProtocolPointer p, address signer) { kernel = k; pointer = p; attestor = signer; }
    function configure(ProvianMemberSettlement a) external { require(address(adapter) == address(0)); adapter = a; }
    function divertIssuance(address a, uint256 g, uint256 c) external returns (uint256) { return _consumeIssuanceTicket(a, g, c); }
    function collectMintContribution(address, uint256, uint256, uint64) external pure { revert("legacy disabled"); }
    function _issuanceDomain() internal view override returns (address, address, address) { return (address(pointer), address(kernel), address(adapter)); }
    function _issuanceAttestor() internal view override returns (address) { return attestor; }
    function _issuanceCurrent(uint256 revision) internal view override { pointer.requireCurrent(revision, 8, address(this)); }
    function _issuanceMonth() internal pure override returns (uint256) { return 100; }
    function _issuanceRule(uint256) internal pure override returns (bytes32, uint16) { return (sha256("member rule"), 100); }
    function _issuanceConsent(address) internal pure override returns (bool, uint256) { return (true, 1); }
    function _issuanceBatchRecord(bytes32 batch) internal view override returns (bool, bytes32) {
        ProvianPVT9.BatchRecord memory r = kernel.getBatchRecord(batch); return (r.settled, r.settlementDigest);
    }
    function _creditTicketContribution(address, uint256 amount) internal override { contributions += amount; }
}
contract ProvianMemberSettlementTicketsTest is Test {
    uint256 constant ATTESTOR = 0x123456; address constant MEMBER = address(0xa11ce);
    EnvelopeKernelMock kernel; EnvelopePoolMock pool; ProvianMemberSettlement adapter; ProvianProtocolPointer pointer;
    function setUp() public {
        kernel = new EnvelopeKernelMock();
        pointer = new ProvianProtocolPointer(address(new ProvianHashAccount(sha256("test pointer root"))));
        pool = new EnvelopePoolMock(kernel, pointer, vm.addr(ATTESTOR));
        adapter = new ProvianMemberSettlement(ProvianPVT9(address(kernel)), address(this), pool, pointer);
        kernel.configure(pool, address(adapter)); pool.configure(adapter);
        address[10] memory components; bytes32[10] memory hashes;
        for (uint256 i; i < 10; ++i) { components[i] = address(uint160(1000 + i)); vm.etch(components[i], hex"00"); }
        components[0] = address(kernel); components[8] = address(pool); components[9] = address(adapter);
        for (uint256 i; i < 10; ++i) hashes[i] = components[i].codehash;
        vm.prank(pointer.authority()); pointer.publish(0, components, hashes);
    }
    function callFor(bool genesis, bytes32 batch) private pure returns (bytes memory) {
        if (genesis) {
            ProvianPVT9.GenesisRecipient[] memory recipients = new ProvianPVT9.GenesisRecipient[](1);
            recipients[0] = ProvianPVT9.GenesisRecipient(MEMBER, 1);
            ProvianPVT9.GenesisPEClaim[] memory claims = new ProvianPVT9.GenesisPEClaim[](1);
            claims[0] = ProvianPVT9.GenesisPEClaim(bytes32(uint256(9)), bytes32(uint256(10)), bytes32(uint256(11)), 0, 1, 10000);
            return abi.encodeCall(ProvianPVT9.settleGenesisPEBatch, (batch, 1, sha256("mint rule"), 0, 1, recipients, claims));
        }
        ProvianPVT9.StandardRecipient[] memory recipients = new ProvianPVT9.StandardRecipient[](1);
        recipients[0] = ProvianPVT9.StandardRecipient(MEMBER, ProvianPVT9.BeneficiaryClass.HumanResolving, 1);
        ProvianPVT9.StandardPEClaim[] memory claims = new ProvianPVT9.StandardPEClaim[](1);
        claims[0] = ProvianPVT9.StandardPEClaim(bytes32(uint256(9)), 10000);
        return abi.encodeCall(ProvianPVT9.settleStandardPEBatch, (batch, 1, sha256("mint rule"), 0, 1, recipients, claims));
    }
    function fixture(bool genesis) private pure returns (bytes memory call, RecourseIssuanceTickets.IssuanceContext memory c,
        RecourseIssuanceTickets.IssuanceTicket[] memory t) {
        call = callFor(genesis, bytes32(uint256(1)));
        c = RecourseIssuanceTickets.IssuanceContext(bytes32(uint256(1)), genesis ? 1 : 0, 1, sha256("mint rule"), keccak256(call), 1, 100, sha256("member rule"));
        t = new RecourseIssuanceTickets.IssuanceTicket[](1);
        t[0] = RecourseIssuanceTickets.IssuanceTicket(MEMBER, 10000, 9900, 100, 1, true);
    }
    function sign(RecourseIssuanceTickets.IssuanceContext memory c, RecourseIssuanceTickets.IssuanceTicket[] memory t) private returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ATTESTOR, pool.issuanceDigest(c, t)); return abi.encodePacked(r, s, v);
    }
    function testBothSettlementLanesUseActualAdapterAndExactTicketEnvelope() public {
        for (uint256 i; i < 2; ++i) {
            (bytes memory call, RecourseIssuanceTickets.IssuanceContext memory c, RecourseIssuanceTickets.IssuanceTicket[] memory t) = fixture(i == 1);
            c.batchId = bytes32(i + 1); call = callFor(i == 1, c.batchId); c.settlementDigest = keccak256(call);
            adapter.settleMemberBatch(call, c, t, sign(c, t));
        }
        assertEq(kernel.balanceOf(MEMBER), 19600); assertEq(kernel.totalSupply(), 20000); assertEq(pool.contributions(), 200);
    }
    function testSubmitterCannotWrapAnArbitraryKernelCall() public {
        (, RecourseIssuanceTickets.IssuanceContext memory c, RecourseIssuanceTickets.IssuanceTicket[] memory t) = fixture(false);
        bytes memory call = abi.encodeCall(EnvelopeKernelMock.arbitraryTransfer, (MEMBER, 999));
        bytes memory signature = sign(c, t);
        vm.expectRevert(); adapter.settleMemberBatch(call, c, t, signature);
        assertEq(kernel.totalSupply(), 0);
    }
    function testUnknownSelectorRefusesEvenWhenItsHeaderTicketsAndResultWouldMatch() public {
        (bytes memory call, RecourseIssuanceTickets.IssuanceContext memory c, RecourseIssuanceTickets.IssuanceTicket[] memory t) = fixture(false);
        bytes4 selector = EnvelopeKernelMock.unapprovedSettlement.selector;
        for (uint256 i; i < 4; ++i) call[i] = selector[i];
        c.settlementDigest = keccak256(call); bytes memory signature = sign(c, t);
        vm.expectRevert(); adapter.settleMemberBatch(call, c, t, signature);
        assertEq(kernel.totalSupply(), 0); assertFalse(kernel.getBatchRecord(c.batchId).settled);
    }
    function testDifferentActualBatchOrLaneCannotConsumeOldContext() public {
        (bytes memory call, RecourseIssuanceTickets.IssuanceContext memory c, RecourseIssuanceTickets.IssuanceTicket[] memory t) = fixture(false);
        bytes memory signature = sign(c, t); bytes memory different = callFor(false, bytes32(uint256(2)));
        vm.expectRevert(); adapter.settleMemberBatch(different, c, t, signature);
        c.lane = 1; signature = sign(c, t);
        vm.expectRevert(); adapter.settleMemberBatch(call, c, t, signature);
        assertEq(kernel.totalSupply(), 0);
    }
    function testWrongFinalDigestRollsBackActualKernelMintAndPoolCredit() public {
        (bytes memory call, RecourseIssuanceTickets.IssuanceContext memory c, RecourseIssuanceTickets.IssuanceTicket[] memory t) = fixture(false);
        c.settlementDigest = sha256("different digest"); bytes memory signature = sign(c, t);
        vm.expectRevert(); adapter.settleMemberBatch(call, c, t, signature);
        assertEq(kernel.totalSupply(), 0); assertEq(pool.contributions(), 0);
        assertFalse(kernel.getBatchRecord(c.batchId).settled);
    }
    function testCancellationRequiresSubmitterAndCannotCancelCompletedBatch() public {
        (bytes memory call, RecourseIssuanceTickets.IssuanceContext memory c, RecourseIssuanceTickets.IssuanceTicket[] memory t) = fixture(false);
        vm.prank(MEMBER); vm.expectRevert(); adapter.cancelMemberBatch(c.batchId, 1);
        adapter.settleMemberBatch(call, c, t, sign(c, t));
        vm.expectRevert(); adapter.cancelMemberBatch(c.batchId, 1);
        bytes32 fresh = bytes32(uint256(2)); adapter.cancelMemberBatch(fresh, 1); assertTrue(pool.cancelledIssuanceBatch(fresh));
    }
}
