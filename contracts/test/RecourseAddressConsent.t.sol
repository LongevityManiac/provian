// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {Test} from "forge-std/Test.sol";
import {RecourseAddressConsent} from "../src/RecourseAddressConsent.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

contract AddressConsentHarness is RecourseAddressConsent {
    mapping(bytes32 => address) public owners;
    mapping(address => uint256) public balances;
    address public immutable attestor;
    uint256 public month = 100;
    uint256 public burned;
    uint256 public reserve;
    bool public active = true;
    constructor(address signer) { attestor = signer; }
    function setOwner(bytes32 binding, address owner) external { owners[binding] = owner; }
    function fund(address owner, uint256 amount) external { balances[owner] += amount; }
    function setMonth(uint256 value) external { month = value; }
    function retire() external { active = false; }
    function _consentOwner(bytes32 binding) internal view override returns (address) { return owners[binding]; }
    function _consentAttestor() internal view override returns (address) { return attestor; }
    function _consentDomain() internal pure override returns (address, address) { return (address(123), address(456)); }
    function _consentCurrent(uint256 revision) internal view override { require(active && revision == 1, "retired"); }
    function _consentRule(uint256) internal pure override returns (bytes32) { return sha256("signed membership rule"); }
    function _consentMonth() internal view override returns (uint256) { return month; }
    function _executeMembershipDebit(bytes32, address payer, uint256 burn, uint256 contribution) internal override {
        balances[payer] -= burn + contribution; burned += burn; reserve += contribution;
    }
}
contract RecourseAddressConsentTest is Test {
    uint256 constant OWNER_KEY = 0x112233;
    uint256 constant ATTESTOR_KEY = 0x334455;
    uint256 constant OTHER_KEY = 0x556677;
    bytes32 constant BINDING = bytes32(uint256(1));
    AddressConsentHarness pool;
    function setUp() public {
        vm.chainId(8453); vm.warp(1000); vm.roll(50);
        pool = new AddressConsentHarness(vm.addr(ATTESTOR_KEY));
        pool.setOwner(BINDING, vm.addr(OWNER_KEY)); pool.fund(vm.addr(OWNER_KEY), 1000);
    }
    function signature(uint256 key, bytes32 digest) private returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest); return abi.encodePacked(r, s, v);
    }
    function consent() private view returns (RecourseAddressConsent.ConsentAuthorization memory) {
        return RecourseAddressConsent.ConsentAuthorization(BINDING, vm.addr(OWNER_KEY), 0, true, 1,
            sha256("signed membership rule"), block.timestamp + 300);
    }
    function enroll() private {
        RecourseAddressConsent.ConsentAuthorization memory c = consent(); bytes32 digest = pool.consentDigest(c);
        pool.setAddressConsent(c, signature(OWNER_KEY, digest), signature(ATTESTOR_KEY, digest));
    }
    function debit() private view returns (RecourseAddressConsent.DebitAuthorization memory) {
        return RecourseAddressConsent.DebitAuthorization(BINDING, vm.addr(OWNER_KEY), 100, 100, 100,
            0, 1, 1, sha256("signed membership rule"), block.timestamp + 300);
    }
    function execute(RecourseAddressConsent.DebitAuthorization memory d) private {
        bytes32 digest = pool.debitDigest(d);
        pool.executeMembershipDebit(d, signature(OWNER_KEY, digest), signature(ATTESTOR_KEY, digest));
    }
    function executeRejected(RecourseAddressConsent.DebitAuthorization memory d) private {
        bytes32 digest = pool.debitDigest(d);
        bytes memory owner = signature(OWNER_KEY, digest); bytes memory attestor = signature(ATTESTOR_KEY, digest);
        vm.expectRevert(); pool.executeMembershipDebit(d, owner, attestor);
    }
    function testSponsorRequiresOwnerAndAttestorForIndependentAddressConsent() public {
        RecourseAddressConsent.ConsentAuthorization memory c = consent(); bytes32 digest = pool.consentDigest(c);
        bytes memory owner = signature(OWNER_KEY, digest); bytes memory attestor = signature(ATTESTOR_KEY, digest);
        vm.expectRevert(); pool.setAddressConsent(c, "", attestor);
        vm.expectRevert(); pool.setAddressConsent(c, owner, "");
        pool.setAddressConsent(c, owner, attestor);
        (uint256 nonce, uint256 generation, bool joined) = pool.addressConsent(BINDING);
        assertEq(nonce, 1); assertEq(generation, 1); assertTrue(joined);
        vm.expectRevert(); pool.setAddressConsent(c, owner, attestor);
    }
    function testAllowanceOrAttestorAloneCannotDebitAndExactOwnerMandateExecutesOnce() public {
        enroll(); RecourseAddressConsent.DebitAuthorization memory d = debit(); bytes32 digest = pool.debitDigest(d);
        bytes memory owner = signature(OWNER_KEY, digest); bytes memory attestor = signature(ATTESTOR_KEY, digest);
        vm.expectRevert(); pool.executeMembershipDebit(d, "", attestor);
        vm.expectRevert(); pool.executeMembershipDebit(d, owner, "");
        assertEq(pool.balances(vm.addr(OWNER_KEY)), 1000);
        pool.executeMembershipDebit(d, owner, attestor);
        assertEq(pool.balances(vm.addr(OWNER_KEY)), 800); assertEq(pool.burned(), 100); assertEq(pool.reserve(), 100);
        vm.expectRevert(); pool.executeMembershipDebit(d, owner, attestor);
    }
    function testEveryDebitFieldIsBoundAndAnotherOwnerCannotSupplyTheMandate() public {
        enroll(); RecourseAddressConsent.DebitAuthorization memory d = debit(); bytes32 digest = pool.debitDigest(d);
        bytes memory owner = signature(OWNER_KEY, digest); bytes memory attestor = signature(ATTESTOR_KEY, digest);
        bytes memory other = signature(OTHER_KEY, digest);
        vm.expectRevert(); pool.executeMembershipDebit(d, other, attestor);
        d.burn++; vm.expectRevert(); pool.executeMembershipDebit(d, owner, attestor); d.burn--;
        d.reserve++; vm.expectRevert(); pool.executeMembershipDebit(d, owner, attestor); d.reserve--;
        d.month--; vm.expectRevert(); pool.executeMembershipDebit(d, owner, attestor); d.month++;
        d.payer = vm.addr(OTHER_KEY); vm.expectRevert(); pool.executeMembershipDebit(d, owner, attestor); d.payer = vm.addr(OWNER_KEY);
        d.binding = bytes32(uint256(2)); vm.expectRevert(); pool.executeMembershipDebit(d, owner, attestor); d.binding = BINDING;
        d.nonce++; vm.expectRevert(); pool.executeMembershipDebit(d, owner, attestor); d.nonce--;
        d.generation++; vm.expectRevert(); pool.executeMembershipDebit(d, owner, attestor); d.generation--;
        d.revision++; vm.expectRevert(); pool.executeMembershipDebit(d, owner, attestor); d.revision--;
        d.ruleHash = bytes32(uint256(9)); vm.expectRevert(); pool.executeMembershipDebit(d, owner, attestor); d.ruleHash = debit().ruleHash;
        d.expiresAt--; vm.expectRevert(); pool.executeMembershipDebit(d, owner, attestor);
        assertEq(pool.balances(vm.addr(OWNER_KEY)), 1000);
    }
    function testCancellationInvalidatesRetainedSignedBytesBeforePayerSwitch() public {
        enroll(); RecourseAddressConsent.DebitAuthorization memory d = debit(); bytes32 digest = pool.debitDigest(d);
        bytes memory owner = signature(OWNER_KEY, digest); bytes memory attestor = signature(ATTESTOR_KEY, digest);
        vm.expectRevert(); pool.cancelMembershipDebit(BINDING, 0);
        vm.prank(vm.addr(OWNER_KEY)); pool.cancelMembershipDebit(BINDING, 0);
        vm.expectRevert(); pool.executeMembershipDebit(d, owner, attestor);
        assertEq(pool.debitNonce(BINDING), 1); assertEq(pool.burned(), 0);
    }
    function testCoordinatedLeaveRequiresBothSignaturesAndRevokesInvoiceAcrossRejoin() public {
        enroll(); RecourseAddressConsent.DebitAuthorization memory d = debit(); bytes32 digest = pool.debitDigest(d);
        bytes memory owner = signature(OWNER_KEY, digest); bytes memory attestor = signature(ATTESTOR_KEY, digest);
        RecourseAddressConsent.ConsentAuthorization memory departure = consent();
        departure.nonce = 1; departure.joined = false;
        bytes32 leaveDigest = pool.consentDigest(departure);
        bytes memory ownerLeave = signature(OWNER_KEY, leaveDigest);
        bytes memory attestorLeave = signature(ATTESTOR_KEY, leaveDigest);
        vm.expectRevert(); pool.setAddressConsent(departure, ownerLeave, "");
        vm.expectRevert(); pool.setAddressConsent(departure, "", attestorLeave);
        pool.setAddressConsent(departure, ownerLeave, attestorLeave);
        (uint256 departureNonce,, bool departed) = pool.addressConsent(BINDING);
        assertEq(departureNonce, 2); assertFalse(departed);
        RecourseAddressConsent.ConsentAuthorization memory c = consent(); c.nonce = 2;
        bytes32 joinDigest = pool.consentDigest(c);
        pool.setAddressConsent(c, signature(OWNER_KEY, joinDigest), signature(ATTESTOR_KEY, joinDigest));
        vm.expectRevert(); pool.executeMembershipDebit(d, owner, attestor);
        (, uint256 generation, bool joined) = pool.addressConsent(BINDING); assertEq(generation, 2); assertTrue(joined);
        assertEq(pool.debitNonce(BINDING), 1);
    }
    function testRetirementExpiryAndMoreThanOneMonthLateRefuseEvenBothSignatures() public {
        enroll(); RecourseAddressConsent.DebitAuthorization memory d = debit();
        pool.setMonth(102); executeRejected(d);
        pool.setMonth(101); execute(d); // A valid previous-month exact obligation remains payable during grace.
        d.nonce = 1; d.expiresAt = block.timestamp - 1; executeRejected(d);
        d.expiresAt = block.timestamp + 301; executeRejected(d);
        d.expiresAt = block.timestamp + 300; pool.retire(); executeRejected(d);
    }
    function testDebitForAnotherPoolOrChainCannotReplay() public {
        enroll(); RecourseAddressConsent.DebitAuthorization memory d = debit(); bytes32 digest = pool.debitDigest(d);
        bytes memory owner = signature(OWNER_KEY, digest); bytes memory attestor = signature(ATTESTOR_KEY, digest);
        vm.chainId(8454);
        vm.expectRevert(); pool.executeMembershipDebit(d, owner, attestor); vm.chainId(8453);
        AddressConsentHarness other = new AddressConsentHarness(vm.addr(ATTESTOR_KEY));
        assertTrue(other.debitDigest(d) != digest);
        pool.executeMembershipDebit(d, owner, attestor);
    }
    function testDebitFailureDoesNotConsumeNonceOrRecordBurn() public {
        enroll(); RecourseAddressConsent.DebitAuthorization memory d = debit(); d.reserve = 1001;
        executeRejected(d);
        assertEq(pool.debitNonce(BINDING), 0); assertEq(pool.burned(), 0); assertEq(pool.reserve(), 0);
        execute(debit()); assertEq(pool.debitNonce(BINDING), 1);
    }
    function testRecoveredOwnerInvalidatesPreviousPayerSignature() public {
        enroll(); RecourseAddressConsent.DebitAuthorization memory d = debit(); bytes32 digest = pool.debitDigest(d);
        bytes memory owner = signature(OWNER_KEY, digest); bytes memory attestor = signature(ATTESTOR_KEY, digest);
        pool.setOwner(BINDING, vm.addr(OTHER_KEY));
        vm.expectRevert(); pool.executeMembershipDebit(d, owner, attestor);
        assertEq(pool.balances(vm.addr(OWNER_KEY)), 1000);
    }
    function testActualSdkDigestsMatchContractForConsentAndExactDebit() public {
        string[] memory command = new string[](8);
        command[0] = "node"; command[1] = string.concat(vm.projectRoot(), "/test/helpers/membership-digest.cjs");
        command[3] = "8453"; command[4] = Strings.toHexString(address(123));
        command[5] = Strings.toHexString(address(456)); command[6] = Strings.toHexString(address(pool));
        RecourseAddressConsent.ConsentAuthorization memory c = consent();
        command[2] = "consent";
        command[7] = string.concat('{"binding":"', Strings.toHexString(uint256(BINDING), 32),
            '","account":"', Strings.toHexString(c.account), '","nonce":"0","joined":true,"revision":"1","ruleHash":"',
            Strings.toHexString(uint256(c.ruleHash), 32), '","expiresAt":"1300"}');
        assertEq(bytes32(vm.ffi(command)), pool.consentDigest(c));
        RecourseAddressConsent.DebitAuthorization memory d = debit();
        command[2] = "debit";
        command[7] = string.concat('{"binding":"', Strings.toHexString(uint256(BINDING), 32),
            '","payer":"', Strings.toHexString(d.payer), '","month":"100","burn":"100","reserve":"100","nonce":"0","generation":"1","revision":"1","ruleHash":"',
            Strings.toHexString(uint256(d.ruleHash), 32), '","expiresAt":"1300"}');
        assertEq(bytes32(vm.ffi(command)), pool.debitDigest(d));
    }
}
