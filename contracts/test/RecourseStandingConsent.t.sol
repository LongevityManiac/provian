// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {Test} from "forge-std/Test.sol";
import {RecourseStandingConsent} from "../src/RecourseStandingConsent.sol";
import {RecourseAddressConsent, RecourseAddressConsentState} from "../src/RecourseAddressConsent.sol";
import {RecourseMembershipRules} from "../src/RecourseMembershipRules.sol";
import {ProvianProtocolPointer} from "../src/ProvianProtocolPointer.sol";
import {ProvianHashAccount} from "../src/ProvianHashAccount.sol";

contract StandingHost is RecourseAddressConsentState {
    RecourseStandingConsent public immutable standingMembership;
    ProvianProtocolPointer public pointer;
    address public identityAttestor;
    address public restorationAuthority = address(0xAAAA);
    bool public poolHistoryReady = true;
    uint256 public month = 100;
    RecourseMembershipRules.MonthlyRule internal rule;
    mapping(bytes32 => bool) public requiresSnapshotRecovery;
    function requireRecovery(bytes32 id) external { requiresSnapshotRecovery[id]=true; }
    mapping(bytes32 => address) public consentAccount;
    mapping(address => uint256) public balances;
    uint256 public burned;
    uint256 public reserve;
    constructor(address attestor, ProvianProtocolPointer pointer_) {
        identityAttestor = attestor; pointer = pointer_; standingMembership = new RecourseStandingConsent();
        rule = RecourseMembershipRules.MonthlyRule(0, 100, 100, 100, sha256("rule"));
    }
    function pvt() external pure returns(address) { return address(0x777); }
    function registryOperator() external view returns(address) { return address(this); }
    function calendarMonth(uint256) external view returns(uint256) { return month; }
    function monthlyRule(uint256) external view returns(RecourseMembershipRules.MonthlyRule memory) { return rule; }
    function bind(bytes32 id, address account) external { consentAccount[id] = account; }
    function fund(address account, uint256 amount) external { balances[account] += amount; }
    function setMonth(uint256 value) external { month = value; }
    function raiseRule() external { rule.participationBurn = 101; rule.signedRuleHash = sha256("higher rule"); }
    function raiseRuleWithSameHash() external { rule.participationBurn = 101; }
    function collapseRoles() external { restorationAuthority = identityAttestor; }
    function setReady(bool ready) external { poolHistoryReady = ready; }
    function importState(uint8 kind, bytes calldata data) external { standingMembership.importState(kind, data); }
    function setConsent(bytes32 id, uint256 nonce, uint256 generation, bool joined) external {
        addressConsent[id] = AddressConsent(nonce, generation, joined);
    }
    function applyStandingConsent(bytes32 id, address, uint256 nonce, bool joined) external returns(uint256) {
        require(msg.sender == address(standingMembership)); AddressConsent storage c = addressConsent[id]; require(c.nonce == nonce);
        ++c.nonce; ++debitNonce[id]; if (joined && !c.joined) ++c.generation; c.joined = joined; return c.nonce;
    }
    function collectStandingDebit(RecourseAddressConsent.DebitAuthorization calldata d) external {
        require(msg.sender == address(standingMembership)); require(d.nonce == debitNonce[d.binding]++);
        balances[d.payer] -= d.burn + d.reserve; burned += d.burn; reserve += d.reserve;
    }
}
contract RecourseStandingConsentTest is Test {
    uint256 constant OWNER = 0x112233; uint256 constant ATTESTOR = 0x334455; uint256 constant OTHER = 0x556677;
    bytes32 constant ID = bytes32(uint256(1)); bytes32 constant EXIT = bytes32(uint256(1001));
    StandingHost host; RecourseStandingConsent consent; ProvianProtocolPointer pointer;
    function setUp() public {
        vm.chainId(8453); vm.warp(1000);
        pointer = new ProvianProtocolPointer(address(new ProvianHashAccount(sha256("TEST ONLY pointer"))));
        host = new StandingHost(vm.addr(ATTESTOR), pointer); consent = host.standingMembership();
        address[10] memory targets; bytes32[10] memory hashes;
        for(uint256 i; i<10; ++i) { targets[i] = address(uint160(100+i)); vm.etch(targets[i],hex"00"); }
        targets[0] = address(0x777); vm.etch(targets[0],hex"00"); targets[8] = address(host);
        for(uint256 i; i<10; ++i) hashes[i] = targets[i].codehash;
        vm.mockCall(address(0x777),abi.encodeWithSignature("restorationAuthority()"),abi.encode(address(0xAAAA)));
        vm.prank(pointer.authority()); pointer.publish(0, targets, hashes);
        host.bind(ID, vm.addr(OWNER)); host.fund(vm.addr(OWNER), 1000);
    }
    function sign(uint256 key, bytes32 digest) private pure returns(bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest); return abi.encodePacked(r,s,v);
    }
    function approval(bytes32 exitSecret, bool payer) private view returns(RecourseStandingConsent.StandingAuthorization memory a) {
        (uint256 nonce,,) = host.addressConsent(ID);
        a.consent = RecourseAddressConsent.ConsentAuthorization(ID, host.consentAccount(ID), nonce, true, 1,
            host.monthlyRule(host.month()).signedRuleHash, block.timestamp+300);
        a.admissionMonth = host.month();
        a.fixedChargePayer = payer; a.burnLimit = payer ? host.monthlyRule(host.month()).participationBurn : 0;
        a.reserveLimit = payer ? host.monthlyRule(host.month()).noEarningsContribution : 0;
        a.earningsBpsLimit = host.monthlyRule(host.month()).earningsBps; a.exitCommitment = sha256(abi.encodePacked(exitSecret)); a.exitSalt = keccak256(abi.encode(exitSecret));
    }
    function join(bytes32 exitSecret, bool payer) private {
        RecourseStandingConsent.StandingAuthorization memory a = approval(exitSecret,payer);
        bytes32 digest = consent.standingConsentDigest(a); consent.setStandingConsent(a, sign(OWNER,digest), sign(ATTESTOR,digest));
    }
    function debit(uint256 month, uint256 burn, uint256 reserve) private view returns(RecourseAddressConsent.DebitAuthorization memory d) {
        (,uint256 generation,) = host.addressConsent(ID);
        d = RecourseAddressConsent.DebitAuthorization(ID,host.consentAccount(ID),month,burn,reserve,
            host.debitNonce(ID),generation,1,host.monthlyRule(month).signedRuleHash,block.timestamp+300);
    }
    function collect(RecourseAddressConsent.DebitAuthorization memory d) private {
        bytes memory signature = sign(ATTESTOR,consent.debitDigest(d)); consent.executeStandingDebit(d,signature);
    }
    function reject(RecourseAddressConsent.DebitAuthorization memory d) private {
        bytes memory signature = sign(ATTESTOR,consent.debitDigest(d)); vm.expectRevert(); consent.executeStandingDebit(d,signature);
    }
    function testOneApprovalAllowsLaterMonthWithoutOwnerSignatureOrEth() public {
        vm.deal(vm.addr(OWNER),0); join(EXIT,true); collect(debit(100,100,0));
        host.setMonth(101); collect(debit(100,0,100)); collect(debit(101,100,0));
        assertEq(host.balances(vm.addr(OWNER)),700); assertEq(host.burned(),200); assertEq(host.reserve(),100);
        assertEq(vm.addr(OWNER).balance,0);
    }
    function testMissingOwnerOrAttestorAndChangedApprovedFieldsCannotJoin() public {
        RecourseStandingConsent.StandingAuthorization memory a = approval(EXIT,true); bytes32 digest = consent.standingConsentDigest(a);
        bytes memory owner = sign(OWNER,digest); bytes memory attestor = sign(ATTESTOR,digest);
        vm.expectRevert(); consent.setStandingConsent(a,"",attestor); vm.expectRevert(); consent.setStandingConsent(a,owner,"");
        a.fixedChargePayer = false; vm.expectRevert(); consent.setStandingConsent(a,owner,attestor);
        a.fixedChargePayer = true; a.exitCommitment = sha256("changed"); vm.expectRevert(); consent.setStandingConsent(a,owner,attestor);
    }
    function testSingleActionLeaveNeedsNoEthAndStopsRetainedDebitImmediately() public {
        join(EXIT,true); RecourseAddressConsent.DebitAuthorization memory d = debit(100,100,0);
        bytes memory sig = sign(ATTESTOR,consent.debitDigest(d)); (uint256 nonce,,) = host.addressConsent(ID);
        consent.leaveStandingMembership(ID,nonce,EXIT,1);
        vm.expectRevert(); consent.executeStandingDebit(d,sig); assertFalse(consent.permitsEarnings(ID,100));
        assertEq(host.balances(vm.addr(OWNER)),1000);
    }
    function testWrongExitOrOldExitCannotLeaveRejoinedMandate() public {
        join(EXIT,true); vm.expectRevert(); consent.leaveStandingMembership(ID,1,bytes32(uint256(999)),1);
        consent.leaveStandingMembership(ID,1,EXIT,1); join(bytes32(uint256(1002)),true);
        vm.expectRevert(); consent.leaveStandingMembership(ID,3,EXIT,1); assertTrue(consent.permitsEarnings(ID,100));
    }
    function testMonthCountersSurviveRenewalLeaveAndRejoin() public {
        join(EXIT,true); collect(debit(100,100,0)); reject(debit(100,1,0));
        join(bytes32(uint256(1002)),true); reject(debit(100,1,0));
        (uint256 nonce,,) = host.addressConsent(ID); consent.leaveStandingMembership(ID,nonce,bytes32(uint256(1002)),1);
        join(bytes32(uint256(1003)),true); reject(debit(100,1,0)); assertEq(host.burned(),100);
    }
    function testPartialCollectionsCannotExceedApprovedMonthAndRollbackOnFailure() public {
        join(EXIT,true); collect(debit(100,40,0)); collect(debit(100,60,0)); reject(debit(100,1,0));
        (uint256 burn,uint256 reserve) = consent.monthlyCollection(ID,100); assertEq(burn,100); assertEq(reserve,0);
        uint256 nonce = host.debitNonce(ID); host.setMonth(101); reject(debit(100,0,101)); assertEq(host.debitNonce(ID),nonce);
    }
    function testSameRuleHashCannotSmuggleHigherAmountsAcrossMonthBoundary() public {
        RecourseStandingConsent.StandingAuthorization memory a=approval(EXIT,true); bytes32 digest=consent.standingConsentDigest(a);
        bytes memory owner=sign(OWNER,digest); bytes memory attestor=sign(ATTESTOR,digest);
        host.setMonth(101); host.raiseRuleWithSameHash(); vm.expectRevert(); consent.setStandingConsent(a,owner,attestor);
        a.burnLimit=101; vm.expectRevert(); consent.setStandingConsent(a,owner,attestor);
    }
    function testRejoinWithinGracePreservesRemainingPreviousMonthInvoice() public {
        join(EXIT,true); collect(debit(100,40,0)); host.setMonth(101);
        consent.leaveStandingMembership(ID,1,EXIT,1); join(bytes32(uint256(1002)),true);
        collect(debit(100,60,100)); reject(debit(100,1,0));
        assertEq(host.burned(),100); assertEq(host.reserve(),100);
    }
    function testRejoinAfterGraceCannotCollectBeforeNewAdmission() public {
        join(EXIT,true); consent.leaveStandingMembership(ID,1,EXIT,1); host.setMonth(103);
        join(bytes32(uint256(1002)),true); reject(debit(102,100,100)); collect(debit(103,100,0));
    }
    function testRejoinSettlesTwoProtectedMonthsAtomicallyWithFreshSignatures() public {
        join(EXIT,true); collect(debit(100,40,0));
        consent.leaveStandingMembership(ID,1,EXIT,1); host.setMonth(110);
        RecourseStandingConsent.StandingAuthorization memory a = approval(bytes32(uint256(1002)),true);
        a.rejoinPayments = new RecourseStandingConsent.RejoinPayment[](2);
        a.rejoinPayments[0] = RecourseStandingConsent.RejoinPayment(100,60,100,sha256("rule"));
        a.rejoinPayments[1] = RecourseStandingConsent.RejoinPayment(101,100,100,sha256("rule"));
        bytes32 digest = consent.standingConsentDigest(a);
        bytes memory owner = sign(OWNER,digest); bytes memory attestor = sign(ATTESTOR,digest);
        a.rejoinPayments[0].burn = 61;
        vm.expectRevert(); consent.setStandingConsent(a,owner,attestor);
        assertEq(host.balances(vm.addr(OWNER)),960);
        a.rejoinPayments[0].burn = 60;
        consent.setStandingConsent(a,owner,attestor);
        assertEq(host.balances(vm.addr(OWNER)),600); assertEq(host.burned(),200); assertEq(host.reserve(),200);
        (uint256 burn,uint256 reserve) = consent.monthlyCollection(ID,100); assertEq(burn,100); assertEq(reserve,100);
        (burn,reserve) = consent.monthlyCollection(ID,102); assertEq(burn,0); assertEq(reserve,0);
        vm.expectRevert(); consent.setStandingConsent(a,owner,attestor);
        reject(debit(101,1,0)); // automatic collection still cannot reach old months
    }
    function testRejoinFailureRollsBackAllPaymentsAndDoesNotActivateConsent() public {
        join(EXIT,true); consent.leaveStandingMembership(ID,1,EXIT,1); host.setMonth(110);
        RecourseStandingConsent.StandingAuthorization memory a = approval(bytes32(uint256(1002)),true);
        a.rejoinPayments = new RecourseStandingConsent.RejoinPayment[](2);
        a.rejoinPayments[0] = RecourseStandingConsent.RejoinPayment(100,100,100,sha256("rule"));
        a.rejoinPayments[1] = RecourseStandingConsent.RejoinPayment(101,100,800,sha256("rule"));
        bytes32 digest = consent.standingConsentDigest(a);
        bytes memory owner = sign(OWNER,digest); bytes memory attestor = sign(ATTESTOR,digest);
        uint256 nonce = host.debitNonce(ID);
        vm.expectRevert(); consent.setStandingConsent(a,owner,attestor);
        assertEq(host.balances(vm.addr(OWNER)),1000); assertEq(host.burned(),0); assertEq(host.reserve(),0);
        assertEq(host.debitNonce(ID),nonce); (,,bool joined) = host.addressConsent(ID); assertFalse(joined);
        (uint256 burn,uint256 reserve) = consent.monthlyCollection(ID,100); assertEq(burn,0); assertEq(reserve,0);
    }
    function testRejoinPercentageRemainderIsNotCappedAtFlatContribution() public {
        join(EXIT,true); consent.leaveStandingMembership(ID,1,EXIT,1); host.setMonth(110);
        RecourseStandingConsent.StandingAuthorization memory a = approval(bytes32(uint256(1002)),true);
        a.rejoinPayments = new RecourseStandingConsent.RejoinPayment[](1);
        a.rejoinPayments[0] = RecourseStandingConsent.RejoinPayment(100,100,500,sha256("rule"));
        bytes32 digest = consent.standingConsentDigest(a);
        consent.setStandingConsent(a,sign(OWNER,digest),sign(ATTESTOR,digest));
        assertEq(host.reserve(),500); assertEq(host.burned(),100);
    }
    function testSignedRejoinCannotCrossInvoiceMonthBoundary() public {
        join(EXIT,true); host.setMonth(101);
        consent.leaveStandingMembership(ID,1,EXIT,1);
        RecourseStandingConsent.StandingAuthorization memory a = approval(bytes32(uint256(1002)),true);
        a.rejoinPayments = new RecourseStandingConsent.RejoinPayment[](1);
        a.rejoinPayments[0] = RecourseStandingConsent.RejoinPayment(100,100,100,sha256("rule"));
        bytes32 digest = consent.standingConsentDigest(a);
        bytes memory owner = sign(OWNER,digest); bytes memory attestor = sign(ATTESTOR,digest);
        // The 300-second owner authorization is still live, but the protected
        // grace-month invoice has now closed and is absent from these bytes.
        vm.warp(block.timestamp+1); host.setMonth(102);
        vm.expectRevert(); consent.setStandingConsent(a,owner,attestor);
        assertEq(host.balances(vm.addr(OWNER)),1000);
    }
    function testHigherRuleNeedsFreshOwnerApproval() public {
        join(EXIT,true); host.raiseRule(); reject(debit(100,101,0));
        join(bytes32(uint256(1002)),true); collect(debit(100,101,0)); assertEq(host.burned(),101);
    }
    function testNonPayerOnlyApprovesEarningsAndCanNeverBeDebitedFromHoldings() public {
        join(EXIT,false); assertTrue(consent.permitsEarnings(ID,100)); assertFalse(consent.permitsEarnings(ID,101));
        reject(debit(100,1,0)); host.setMonth(101); reject(debit(100,0,1)); assertEq(host.balances(vm.addr(OWNER)),1000);
    }
    function testCurrentMonthContributionFutureMonthsAndBackPayAreRefused() public {
        join(EXIT,true); reject(debit(100,0,100)); reject(debit(101,100,0)); reject(debit(99,100,0));
        host.setMonth(102); reject(debit(100,100,100)); collect(debit(101,100,100));
    }
    function testRecoveryInvalidatesOldPayerButPreservesConsumedMonth() public {
        join(EXIT,true); collect(debit(100,50,0)); RecourseAddressConsent.DebitAuthorization memory old = debit(100,50,0);
        host.bind(ID,vm.addr(OTHER)); host.fund(vm.addr(OTHER),1000); reject(old); collect(debit(100,50,0)); reject(debit(100,1,0));
        assertEq(host.balances(vm.addr(OWNER)),950); assertEq(host.balances(vm.addr(OTHER)),950);
    }
    function testAttestorAloneWithoutMandateOrCollapsedAuthorityCannotCollect() public {
        // Use a syntactically nonzero generation; no joined consent still blocks.
        RecourseAddressConsent.DebitAuthorization memory d = debit(100,100,0); d.generation=1; reject(d);
        join(EXIT,true); vm.mockCall(address(0x777),abi.encodeWithSignature("restorationAuthority()"),abi.encode(vm.addr(ATTESTOR))); reject(debit(100,100,0));
    }
    function testExpiredWrongChainWrongRevisionAndReplayAreRefused() public {
        join(EXIT,true); RecourseAddressConsent.DebitAuthorization memory d = debit(100,100,0);
        bytes memory sig=sign(ATTESTOR,consent.debitDigest(d)); vm.chainId(8454); vm.expectRevert(); consent.executeStandingDebit(d,sig);
        vm.chainId(8453); d.revision=2; reject(d); d.revision=1; d.expiresAt=999; reject(d);
        d=debit(100,100,0); collect(d); reject(d);
    }
    function testRecoverySuspensionRenewsExitProofAndPreservesGraceAndConsumedMonth() public {
        host.setReady(false); host.setConsent(ID,1,1,true); host.requireRecovery(ID); host.setMonth(101);
        RecourseAddressConsentState.StandingMandate memory mandate=RecourseAddressConsentState.StandingMandate(100,100,100,100,0,1,sha256(abi.encodePacked(EXIT)),sha256("salt"),true);
        host.importState(9,abi.encode(ID,mandate));
        host.importState(10,abi.encode(ID,uint256(100),RecourseAddressConsentState.MonthlyCollection(100,0)));
        host.setReady(true); assertFalse(consent.permitsEarnings(ID,100)); reject(debit(100,0,100));
        vm.expectRevert(); consent.leaveStandingMembership(ID,1,EXIT,1);
        join(bytes32(uint256(1002)),true); collect(debit(100,0,100)); reject(debit(100,1,0));
        vm.expectRevert(); consent.leaveStandingMembership(ID,2,EXIT,1); assertTrue(consent.permitsEarnings(ID,100));
    }
    function testSuspendedRecoveredOwnerCanLeaveWithoutFinancialRenewalAfterGrace() public {
        host.setReady(false); host.setConsent(ID,1,1,true); host.requireRecovery(ID); host.setMonth(105);
        host.importState(9,abi.encode(ID,RecourseAddressConsentState.StandingMandate(100,100,100,100,0,1,
            sha256(abi.encodePacked(EXIT)),sha256("salt"),true)));
        host.importState(10,abi.encode(ID,uint256(100),RecourseAddressConsentState.MonthlyCollection(100,0)));
        host.setReady(true); host.bind(ID,vm.addr(OTHER));
        vm.expectRevert(); consent.leaveStandingMembership(ID,1,EXIT,1);
        RecourseAddressConsent.ConsentAuthorization memory c=RecourseAddressConsent.ConsentAuthorization(
            ID,vm.addr(OTHER),1,false,1,sha256("old rule is irrelevant"),block.timestamp+300);
        bytes32 digest=consent.authenticatedDepartureDigest(c);
        bytes memory oldSignature=sign(OWNER,digest); vm.expectRevert(); consent.leaveSuspendedMembership(c,oldSignature);
        bytes memory recoveredSignature=sign(OTHER,digest); consent.leaveSuspendedMembership(c,recoveredSignature);
        (uint256 nonce,,bool joined)=host.addressConsent(ID); assertEq(nonce,2); assertFalse(joined);
        assertFalse(consent.permitsEarnings(ID,100)); assertEq(host.burned(),0); assertEq(host.reserve(),0);
        (uint256 paid,)=consent.monthlyCollection(ID,100); assertEq(paid,100);
        vm.expectRevert(); consent.leaveSuspendedMembership(c,recoveredSignature);
    }
    function testSuspendedDepartureRefusesActiveMandateAndUnrecoveredOwnerButSurvivesDelay() public {
        join(EXIT,true);
        RecourseAddressConsent.ConsentAuthorization memory c=RecourseAddressConsent.ConsentAuthorization(
            ID,vm.addr(OWNER),1,false,1,sha256("rule"),block.timestamp+300);
        bytes memory signature=sign(OWNER,consent.authenticatedDepartureDigest(c));
        vm.expectRevert(); consent.leaveSuspendedMembership(c,signature);
        host.setReady(false);host.requireRecovery(ID);
        host.importState(9,abi.encode(ID,RecourseAddressConsentState.StandingMandate(100,100,100,100,0,1,
            sha256(abi.encodePacked(EXIT)),sha256("salt"),true)));host.setReady(true);
        host.bind(ID,address(0));vm.expectRevert();consent.leaveSuspendedMembership(c,signature);
        host.bind(ID,vm.addr(OWNER));vm.warp(block.timestamp+301);consent.leaveSuspendedMembership(c,signature);
        (,,bool joined)=host.addressConsent(ID);assertFalse(joined);
    }
    function testStandingImportOnlyThroughIncompleteHostPreservesLimitsAndMonthCounters() public {
        RecourseAddressConsentState.StandingMandate memory mandate=RecourseAddressConsentState.StandingMandate(100,100,100,100,0,1,sha256(abi.encodePacked(EXIT)),sha256("salt"),true);
        bytes memory data=abi.encode(ID,mandate); vm.expectRevert(); consent.importState(9,data);
        vm.expectRevert(); host.importState(9,data); host.setReady(false); host.setConsent(ID,1,1,true); host.importState(9,data);
        host.importState(10,abi.encode(ID,uint256(100),RecourseAddressConsentState.MonthlyCollection(100,0)));
        host.setReady(true); reject(debit(100,1,0)); (uint256 burn,) = consent.monthlyCollection(ID,100); assertEq(burn,100);
    }
}
