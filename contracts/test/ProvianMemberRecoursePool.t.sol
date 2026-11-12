// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {Test} from "forge-std/Test.sol";
import {RecourseMembershipRules} from "../src/RecourseMembershipRules.sol";
import {RecourseStandingConsent} from "../src/RecourseStandingConsent.sol";
import {RecourseAddressConsent} from "../src/RecourseAddressConsent.sol";
import {RecourseIssuanceTickets} from "../src/RecourseIssuanceTickets.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {RecoursePoolHistory} from "../src/RecoursePoolHistory.sol";
import {ProvianMemberRecoursePool} from "../src/ProvianMemberRecoursePool.sol";
import {ProvianHashAccount} from "../src/ProvianHashAccount.sol";
import {ProvianProtocolPointer} from "../src/ProvianProtocolPointer.sol";
import {ProvianPVT9} from "../src/ProvianPVT9.sol";
contract MemberAuthorizationMock {
    bool public cryptographicBreak;
    function lastGoodBlock() external pure returns (uint256) { return 100; }
    function predecessor() external pure returns (address) { return address(0x5555); }
    function reversalHistoryReady() external pure returns (bool) { return true; }
    mapping(bytes32 => bool) public restoredIdentity;
    function setBreak(bool enabled) external { cryptographicBreak = enabled; }
    function restore(bytes32 identity, address destination) external {
        restoredIdentity[identity] = true;
        ++ownerAuthorizationNonce[identity]; recoveredDestination[identity] = destination;
    }
    mapping(bytes32 => bytes32) public reversalOutcome;
    function setOutcome(bytes32 request, bytes32 digest) external { reversalOutcome[request] = digest; }
    mapping(bytes32 => uint256) public ownerAuthorizationNonce;
    mapping(bytes32 => address) public recoveredDestination;
    function recover(bytes32 identity, address destination) external {
        ++ownerAuthorizationNonce[identity]; recoveredDestination[identity] = destination;
    }
}
contract MemberTokenMock {
    address public immutable BOOTSTRAP_ADMIN;
    address public restorationAuthority;
    MemberAuthorizationMock public ownerAuthorization;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    uint256 public totalSupply;
    bool public dishonestBurn;
    mapping(bytes32 => ProvianPVT9.BatchRecord) private batches;
    function getBatchRecord(bytes32 id) external view returns (ProvianPVT9.BatchRecord memory) { return batches[id]; }
    function finishBatch(bytes32 id, bytes32 digest) external { batches[id].settled = true; batches[id].settlementDigest = digest; }
    function setDishonestBurn(bool value) external { dishonestBurn = value; }
    constructor() { BOOTSTRAP_ADMIN = msg.sender; restorationAuthority = msg.sender; ownerAuthorization = new MemberAuthorizationMock(); }
    function mint(address who, uint256 amount) external { balanceOf[who] += amount; totalSupply += amount; }
    function mintWork(ProvianMemberRecoursePool pool, address who, uint256 gross, uint256 net) external {
        uint256 diverted = pool.divertIssuance(who, gross, net);
        balanceOf[who] += net - diverted;
        balanceOf[address(pool)] += diverted;
        totalSupply += net;
    }
    function approve(address spender, uint256 amount) external returns (bool) { allowance[msg.sender][spender] = amount; return true; }
    function transfer(address to, uint256 amount) external returns (bool) { balanceOf[msg.sender] -= amount; balanceOf[to] += amount; return true; }
    function transferFrom(address from, address to, uint256 amount) external returns (bool) { allowance[from][msg.sender] -= amount; balanceOf[from] -= amount; balanceOf[to] += amount; return true; }
    function burnFrom(address from, uint256 amount) external { allowance[from][msg.sender] -= amount; balanceOf[from] -= amount; if (!dishonestBurn) totalSupply -= amount; }
}
contract ProvianMemberRecoursePoolTest is Test {
    MemberTokenMock token; ProvianMemberRecoursePool pool; ProvianProtocolPointer pointer;
    bytes32 constant ID = bytes32(uint256(1));
    uint256 constant OWNER_KEY = 0x112233; uint256 constant ATTESTOR_KEY = 0x334455;
    address private ownerSigner; address private attestorSigner; uint256 private nextBatch;
    function identityAttestor() external view returns (address) { return attestorSigner; }
    function isValidSignature(bytes32 digest, bytes calldata signature) external view returns (bytes4) {
        return ECDSA.recover(digest, signature) == ownerSigner ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
    }
    function setUp() public {
        vm.warp(1705276800); vm.roll(100);
        ownerSigner = vm.addr(OWNER_KEY); attestorSigner = vm.addr(ATTESTOR_KEY);
        token = new MemberTokenMock(); pointer = new ProvianProtocolPointer(address(new ProvianHashAccount(sha256("pointer signing root TEST ONLY"))));
        pool = new ProvianMemberRecoursePool(ProvianPVT9(address(token)), address(this), address(this), pointer,
            RecourseMembershipRules.MonthlyRule(0, 100 ether, 100 ether, 100, sha256("signed test rule")),
            RecoursePoolHistory.PoolSnapshot(address(0), 0, bytes32(0), 0, false));
        address[10] memory addresses; bytes32[10] memory hashes;
        for (uint256 i; i < 10; ++i) { addresses[i] = address(uint160(1000+i)); vm.etch(addresses[i], hex"00"); }
        addresses[0] = address(token); addresses[8] = address(pool); addresses[9] = address(pool.settlement());
        for (uint256 i; i < 10; ++i) hashes[i] = addresses[i].codehash;
        vm.prank(pointer.authority()); pointer.publish(0, addresses, hashes);
        pool.bind(ID, address(this)); token.approve(address(pool), type(uint256).max);
    }
    function sign(uint256 key, bytes32 digest) private returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest); return abi.encodePacked(r, s, v);
    }
    function join(bytes32 binding, address account, uint256 key) private {
        (uint256 nonce,,) = pool.addressConsent(binding);
        RecourseAddressConsent.ConsentAuthorization memory c = RecourseAddressConsent.ConsentAuthorization(binding, account, nonce,
            true, 1, sha256("signed test rule"), block.timestamp + 300);
        RecourseStandingConsent.StandingAuthorization memory a = RecourseStandingConsent.StandingAuthorization(c,true,100 ether,100 ether,100,sha256(abi.encodePacked(sha256(abi.encode(binding,nonce)))),keccak256(abi.encode(binding,nonce)));
        bytes32 digest = pool.standingMembership().standingConsentDigest(a);
        pool.standingMembership().setStandingConsent(a, sign(key, digest), sign(ATTESTOR_KEY, digest));
    }
    function leaveExternally() external { leave(); }
    function leave() private {
        (uint256 nonce,,) = pool.addressConsent(ID);
        pool.standingMembership().leaveStandingMembership(ID,nonce,sha256(abi.encode(ID,nonce-1)),1);
    }
    function debit(uint256 month, uint256 burn, uint256 reserve) private {
        (, uint256 generation,) = pool.addressConsent(ID);
        RecourseAddressConsent.DebitAuthorization memory d = RecourseAddressConsent.DebitAuthorization(ID, address(this), month,
            burn, reserve, pool.debitNonce(ID), generation, 1, sha256("signed test rule"), block.timestamp + 300);
        bytes32 digest = pool.standingMembership().debitDigest(d);
        pool.standingMembership().executeStandingDebit(d, sign(ATTESTOR_KEY, digest));
    }
    function testConsentAccountResolvesRecoveryBeforeAnyPoolWrite() public {
        assertEq(pool.consentAccount(ID), address(this));
        address replacement = vm.addr(0x998877);
        token.ownerAuthorization().recover(ID, replacement);
        assertEq(pool.primaryAddress(ID), address(this));
        assertEq(pool.consentAccount(ID), replacement);
    }
    function funded() private {
        token.mint(address(this), 1000 ether); join(ID, address(this), OWNER_KEY);
        debit(pool.calendarMonth(block.timestamp), 100 ether, 0);
        vm.warp(1706745600); debit(pool.calendarMonth(block.timestamp)-1, 0, 100 ether);
        debit(pool.calendarMonth(block.timestamp), 100 ether, 0); vm.roll(101);
    }
    function mintWork(address account, uint256 gross, uint256 net, uint256 contribution, bool protectedMember) private {
        bytes32 batch = bytes32(++nextBatch); bytes32 digest = sha256(abi.encode(batch));
        RecourseIssuanceTickets.IssuanceContext memory c = RecourseIssuanceTickets.IssuanceContext(batch, 0, 1,
            sha256("mint rule"), digest, 1, pool.calendarMonth(block.timestamp), sha256("signed test rule"));
        RecourseIssuanceTickets.IssuanceTicket[] memory tickets = new RecourseIssuanceTickets.IssuanceTicket[](1);
        (uint256 nonce,,) = pool.addressConsent(pool.ownerOf(account));
        tickets[0] = RecourseIssuanceTickets.IssuanceTicket(account, gross, net, contribution, nonce, protectedMember);
        bytes memory signature = sign(ATTESTOR_KEY, pool.issuanceDigest(c, tickets));
        vm.prank(address(pool.settlement())); pool.installIssuanceTickets(c, tickets, signature);
        token.mintWork(pool, account, gross, net); token.finishBatch(batch, digest);
        vm.prank(address(pool.settlement())); pool.finishIssuanceTickets(batch);
    }
    function determination(uint256 amount) private view returns (ProvianMemberRecoursePool.Determination memory) {
        return ProvianMemberRecoursePool.Determination(bytes32(uint256(10)), ID, bytes32(uint256(11)), amount,
            sha256("loss"), 0, 1, 100, pool.calendarMonth(1705276800));
    }
    function eligible(ProvianMemberRecoursePool.Determination memory d) private {
        (, uint256 end) = pool.consentPeriods(d.identity, d.membershipGeneration);
        ProvianMemberRecoursePool.LossEligibility memory proof = ProvianMemberRecoursePool.LossEligibility(d,
            sha256("signed test rule"), 1, 2, end == 0 ? 0 : 3);
        pool.admitLossEligibility(proof, sign(ATTESTOR_KEY, pool.lossEligibilityDigest(proof)));
    }
    function outcome(ProvianMemberRecoursePool.Determination memory d, address destination) private {
        token.ownerAuthorization().setOutcome(d.request, sha256(abi.encode(d.request, d.identity, destination, d.shortfall, d.evidenceHash)));
    }
    function determine(ProvianMemberRecoursePool.Determination memory d) private {
        ProvianMemberRecoursePool.Determination[] memory ds = new ProvianMemberRecoursePool.Determination[](1); ds[0] = d; pool.determine(ds);
    }
    function testCustodyTokenAccessorMatchesReserveToken() public view {
        assertEq(pool.pvt(), address(token)); assertEq(address(pool.token()), pool.pvt());
    }
    function testBurnAndNoEarningsContributionAreSeparateAndLeavingRefundsNeither() public {
        token.mint(address(this), 1000 ether); join(ID, address(this), OWNER_KEY);
        assertEq(token.totalSupply(), 1000 ether); // Joining alone does not execute a debit.
        debit(pool.calendarMonth(block.timestamp), 100 ether, 0);
        assertEq(token.totalSupply(), 900 ether); assertEq(pool.availableReserve(), 0);
        vm.warp(1706745600); debit(pool.calendarMonth(block.timestamp)-1, 0, 100 ether);
        debit(pool.calendarMonth(block.timestamp), 100 ether, 0);
        assertEq(token.totalSupply(), 800 ether); assertEq(pool.availableReserve(), 100 ether);
        (bool refunded,) = address(pool).call(abi.encodeWithSignature("redeem(bytes32,uint256)", ID, 100 ether)); assertFalse(refunded);
        leave(); join(ID, address(this), OWNER_KEY);
        assertEq(token.balanceOf(address(this)), 700 ether); assertEq(token.totalSupply(), 800 ether);
    }
    function testMeasuredDebitRejectsAFalseBurnAndPreservesNonce() public {
        token.mint(address(this), 1000 ether); join(ID, address(this), OWNER_KEY); token.setDishonestBurn(true);
        (, uint256 generation,) = pool.addressConsent(ID);
        RecourseAddressConsent.DebitAuthorization memory d = RecourseAddressConsent.DebitAuthorization(ID, address(this), pool.calendarMonth(block.timestamp),
            100 ether, 0, pool.debitNonce(ID), generation, 1, sha256("signed test rule"), block.timestamp + 300);
        bytes32 digest = pool.standingMembership().debitDigest(d); bytes memory attestor = sign(ATTESTOR_KEY, digest);
        RecourseStandingConsent standing = pool.standingMembership();
        vm.expectRevert(ProvianMemberRecoursePool.InvalidInput.selector); standing.executeStandingDebit(d, attestor);
        assertEq(pool.debitNonce(ID), 1); assertEq(token.balanceOf(address(this)), 1000 ether);
    }
    function testRecoveredAddressContributesOnFirstIssuanceWithExistingConsent() public {
        join(ID, address(this), OWNER_KEY); address destination = address(0xBEEF);
        token.ownerAuthorization().recover(ID, destination); pool.bind(ID, destination);
        mintWork(destination, 1000 ether, 990 ether, 10 ether, true);
        assertEq(token.balanceOf(destination), 980 ether); assertEq(pool.availableReserve(), 10 ether);
    }
    function testEarningsStillBurnAndRetain98PercentGrossAfterFloors() public {
        token.mint(address(this), 100 ether); join(ID, address(this), OWNER_KEY);
        debit(pool.calendarMonth(block.timestamp), 100 ether, 0); mintWork(address(this), 100 ether, 99 ether, 1 ether, true);
        assertEq(token.balanceOf(address(this)), 98 ether); assertEq(pool.availableReserve(), 1 ether);
    }
    function testSeparateBindingsNeedSeparateConsentWithoutExposingPrivateOwner() public {
        uint256 secondKey = 0x556677; address second = vm.addr(secondKey); bytes32 binding = bytes32(uint256(2));
        join(ID, address(this), OWNER_KEY); pool.bind(binding, second); join(binding, second, secondKey);
        mintWork(second, 100 ether, 99 ether, 1 ether, true);
        assertEq(pool.ownerOf(second), binding); assertEq(pool.ownerOf(address(this)), ID);
        assertEq(token.balanceOf(second), 98 ether); assertEq(token.balanceOf(address(this)), 0);
    }
    function testPrivateLapseAttestationStopsDiversionWithoutPublicOwnerInvoices() public {
        join(ID, address(this), OWNER_KEY); mintWork(address(this), 100 ether, 99 ether, 0, false);
        assertEq(token.balanceOf(address(this)), 99 ether); assertEq(pool.accountedBacking(), 0);
        (bool invoices,) = address(pool).staticcall(abi.encodeWithSignature("obligations(bytes32,uint256,uint256)", ID, 1, 2024*12));
        assertFalse(invoices);
    }
    function testDonationAndUnpaidBurnCannotPreventCurrentIssuanceDiversion() public {
        join(ID, address(this), OWNER_KEY); mintWork(address(this), 100 ether, 99 ether, 1 ether, true);
        token.mint(address(pool), 1000000000 ether); mintWork(address(this), 100, 99, 1, true);
        assertEq(pool.accountedBacking(), 1 ether + 1); assertEq(token.balanceOf(address(this)), 98 ether + 98);
    }
    function testDeterminationNeedsAuthorityEligibilityAndExactOwnerReversalOutcome() public {
        funded(); ProvianMemberRecoursePool.Determination memory d = determination(40 ether);
        ProvianMemberRecoursePool.Determination[] memory ds = new ProvianMemberRecoursePool.Determination[](1); ds[0] = d;
        vm.prank(address(7)); vm.expectRevert(ProvianMemberRecoursePool.Unauthorized.selector); pool.determine(ds);
        outcome(d, address(this)); vm.expectRevert(ProvianMemberRecoursePool.InvalidInput.selector); pool.determine(ds);
        eligible(d); pool.determine(ds); leave();
        assertEq(pool.availableReserve(), 60 ether); assertEq(pool.withdrawRestoration(d.request, ID), 40 ether);
        assertEq(token.balanceOf(address(pool)), 60 ether);
        vm.expectRevert(ProvianMemberRecoursePool.InvalidInput.selector); pool.determine(ds);
    }
    function testCompleteReversalRecordsFinalOutcomeWithoutAllocatingReserves() public {
        funded(); ProvianMemberRecoursePool.Determination memory d = determination(0); eligible(d);
        vm.expectRevert(ProvianMemberRecoursePool.InvalidInput.selector); pool.recordReversalOnly(d);
        outcome(d, address(this)); pool.recordReversalOnly(d);
        assertTrue(pool.determined(d.request)); assertEq(pool.allocatedRestorations(), 0); assertEq(pool.availableReserve(), 100 ether);
    }
    function testPermissionlessDeliveryPaysOnlyIndependentlyRecoveredOwnerOnce() public {
        funded(); ProvianMemberRecoursePool.Determination memory d = determination(40 ether); eligible(d); outcome(d, address(this)); determine(d);
        address recovered = address(0xAABB); address stranger = address(0xCCDD); token.ownerAuthorization().recover(ID, recovered);
        vm.prank(stranger); assertEq(pool.deliverRestoration(d.request, ID), 40 ether);
        assertEq(token.balanceOf(recovered), 40 ether); assertEq(token.balanceOf(stranger), 0);
        vm.prank(stranger); vm.expectRevert(); pool.deliverRestoration(d.request, ID);
    }
    function testPoolRestoresOnlyExactProvenReversalRemainder() public {
        funded(); ProvianMemberRecoursePool.Determination memory d = determination(41 ether); eligible(d);
        ProvianMemberRecoursePool.Determination memory actual = determination(40 ether); outcome(actual, address(this));
        ProvianMemberRecoursePool.Determination[] memory ds = new ProvianMemberRecoursePool.Determination[](1); ds[0] = d;
        vm.expectRevert(ProvianMemberRecoursePool.InvalidInput.selector); pool.determine(ds);
        eligible(actual); determine(actual); (, uint256 assigned,) = pool.restorationAllocations(actual.request); assertEq(assigned, 40 ether);
    }
    function testRepeatedLeaveCannotMoveHistoricalClosurePastLoss() public {
        join(ID, address(this), OWNER_KEY); vm.roll(101); leave(); vm.roll(103);
        vm.expectRevert(); this.leaveExternally(); (, uint256 end) = pool.consentPeriods(ID, 1); assertEq(end, 101);
        ProvianMemberRecoursePool.Determination memory d = determination(40 ether); d.lossBlock = 102;
        ProvianMemberRecoursePool.LossEligibility memory proof = ProvianMemberRecoursePool.LossEligibility(d, sha256("signed test rule"), 1, 2, 3);
        bytes memory signature = sign(ATTESTOR_KEY, pool.lossEligibilityDigest(proof));
        vm.expectRevert(ProvianMemberRecoursePool.InvalidInput.selector); pool.admitLossEligibility(proof, signature);
    }
    function testSameBlockLossBeforeConsentOrAfterClosureCannotBeAttested() public {
        join(ID, address(this), OWNER_KEY); leave(); vm.roll(101);
        ProvianMemberRecoursePool.Determination memory d = determination(40 ether);
        ProvianMemberRecoursePool.LossEligibility memory proof = ProvianMemberRecoursePool.LossEligibility(d, sha256("signed test rule"), 2, 1, 3);
        bytes memory signature = sign(ATTESTOR_KEY, pool.lossEligibilityDigest(proof));
        vm.expectRevert(); pool.admitLossEligibility(proof, signature);
        proof.lossLogIndex = 4; signature = sign(ATTESTOR_KEY, pool.lossEligibilityDigest(proof));
        vm.expectRevert(); pool.admitLossEligibility(proof, signature);
        proof.lossLogIndex = 2; proof.admissionLogIndex = 1; signature = sign(ATTESTOR_KEY, pool.lossEligibilityDigest(proof));
        pool.admitLossEligibility(proof, signature);
    }
    function testPoolRuntimeFitsChainLimit() public view { assertLt(address(pool).code.length, 24577); }
}
