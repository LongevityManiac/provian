// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ProvianPVT9TestBase} from "./ProvianPVT9TestBase.sol";
import {ProvianPVT9} from "../src/ProvianPVT9.sol";
import {ProvianEscrowV4} from "../src/ProvianEscrowV4.sol";
import {MockUSDC, MockPVT} from "./MockTokens.sol";
import {MockIssuanceIndex} from "./MockIssuanceIndex.sol";

/// @notice Demonstrates what a pre-pointer caller can still do. Token doubles
/// isolate the escrow's fixed token routing; the predecessor kernel is real.
/// These tests do not claim that discretionary restoration rescues mistakes.
contract RetiredContractReachabilityTest is ProvianPVT9TestBase {
    address private constant HOLDER = address(0x1001);
    address private constant RECIPIENT = address(0x1002);
    address private constant FEES = address(0x1003);
    MockUSDC private usdc;
    MockPVT private successorToken;
    ProvianEscrowV4 private oldEscrow;

    function setUp() public override {
        super.setUp();
        usdc = new MockUSDC();
        successorToken = new MockPVT();
        oldEscrow = new ProvianEscrowV4(ADMIN, FEES, address(usdc), address(pvt), address(pvt),
            address(new MockIssuanceIndex()), new ProvianEscrowV4.EscrowSeed[](0));
        _settleStandard(HOLDER, ProvianPVT9.BeneficiaryClass.Unknown, 100 ether);
        usdc.mint(HOLDER, 1000e6);
        successorToken.mint(HOLDER, 100 ether);
        vm.prank(ADMIN);
        pvt.placeAdministrativeHold();
    }

    function testPredecessorHoldStopsMintingButNotOldTransfersOrHolderBurns() public {
        uint256 initial = pvt.balanceOf(HOLDER);
        vm.prank(HOLDER);
        pvt.transfer(RECIPIENT, 10 ether);
        vm.prank(HOLDER);
        pvt.burn(1 ether);
        assertEq(pvt.balanceOf(HOLDER), initial - 11 ether);
        assertEq(pvt.balanceOf(RECIPIENT), 10 ether);
        assertEq(successorToken.balanceOf(HOLDER), 100 ether);
        _expectStandardRevert(ProvianPVT9.AdministrativeHoldActive.selector,
            HOLDER, ProvianPVT9.BeneficiaryClass.Unknown, 1 ether);
    }

    function testOldUsdcEscrowStillAcceptsAndReleasesRecordedPrincipalWhileKernelHeld() public {
        bytes32 id = keccak256("legacy funded obligation");
        vm.startPrank(HOLDER);
        oldEscrow.createEscrow(id, RECIPIENT, 100e6, block.timestamp + 1 days, ProvianEscrowV4.Currency.USDC);
        usdc.approve(address(oldEscrow), 100e6);
        oldEscrow.fundEscrow(id, false);
        assertEq(usdc.balanceOf(address(oldEscrow)), 100e6);
        oldEscrow.releaseEscrow(id);
        vm.stopPrank();
        assertEq(usdc.balanceOf(RECIPIENT) + usdc.balanceOf(FEES), 100e6);
        assertEq(usdc.balanceOf(address(oldEscrow)), 0);
    }

    function testDirectUsdcTransferCreatesNoWithdrawalRightAndSurvivesLegitimateRelease() public {
        vm.prank(HOLDER);
        usdc.transfer(address(oldEscrow), 20e6);
        bytes32 unknown = keccak256("no recorded obligation");
        vm.expectRevert(ProvianEscrowV4.NothingToWithdraw.selector);
        oldEscrow.withdrawResolvedFunds(unknown);
        bytes32 id = keccak256("separate legitimate obligation");
        vm.startPrank(HOLDER);
        oldEscrow.createEscrow(id, RECIPIENT, 100e6, block.timestamp + 1 days, ProvianEscrowV4.Currency.USDC);
        usdc.approve(address(oldEscrow), 100e6);
        oldEscrow.fundEscrow(id, false);
        oldEscrow.releaseEscrow(id);
        vm.stopPrank();
        assertEq(usdc.balanceOf(RECIPIENT) + usdc.balanceOf(FEES), 100e6);
        assertEq(usdc.balanceOf(address(oldEscrow)), 20e6);
        vm.expectRevert(ProvianEscrowV4.NothingToWithdraw.selector);
        oldEscrow.withdrawResolvedFunds(id);
    }

    function testSuccessorTokenSentToOldEscrowIsNotPaidByItsPvtExit() public {
        vm.prank(HOLDER);
        successorToken.transfer(address(oldEscrow), 20 ether);
        assertEq(address(oldEscrow.pvt()), address(pvt));
        bytes32 id = keccak256("old token principal");
        vm.startPrank(HOLDER);
        oldEscrow.createEscrow(id, RECIPIENT, 10 ether, block.timestamp + 1 days, ProvianEscrowV4.Currency.PVT);
        pvt.approve(address(oldEscrow), 10 ether);
        oldEscrow.fundEscrow(id, false);
        oldEscrow.releaseEscrow(id);
        vm.stopPrank();
        assertGt(pvt.balanceOf(RECIPIENT), 0);
        assertEq(pvt.balanceOf(address(oldEscrow)), 0);
        assertEq(successorToken.balanceOf(RECIPIENT), 0);
        assertEq(successorToken.balanceOf(address(oldEscrow)), 20 ether);
    }
}
