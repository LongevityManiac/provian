// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {Test} from "forge-std/Test.sol";
import {RecourseReserveAccounting, IRecourseReserveToken} from "../src/RecourseReserveAccounting.sol";
contract ReserveTestToken is IRecourseReserveToken {
    mapping(address => uint256) public balanceOf;
    function mint(address who, uint256 amount) external { balanceOf[who] += amount; }
    function transfer(address to, uint256 amount) external returns (bool) { balanceOf[msg.sender] -= amount; balanceOf[to] += amount; return true; }
    function transferFrom(address from, address to, uint256 amount) external returns (bool) { balanceOf[from] -= amount; balanceOf[to] += amount; return true; }
}
contract ReserveHarness is RecourseReserveAccounting {
    constructor(IRecourseReserveToken token) RecourseReserveAccounting(token) {}
    function contribute(bytes32 id, uint256 amount) external returns (uint256) { return _contributeReserve(id, msg.sender, amount); }
    function redeem(bytes32 id, uint256 shares) external returns (uint256) { return _redeemReserve(id, msg.sender, shares); }
    function allocate(bytes32[] calldata requests, bytes32[] calldata ids, uint256[] calldata amounts) external { _allocateRestorations(requests, ids, amounts); }
    function withdraw(bytes32 request, bytes32 id) external returns (uint256) { return _withdrawRestoration(request, id, msg.sender); }
}
contract RecourseReserveAccountingTest is Test {
    ReserveTestToken token;
    ReserveHarness pool;
    bytes32 constant ALICE = bytes32(uint256(1));
    bytes32 constant BOB = bytes32(uint256(2));
    bytes32[] requests;
    bytes32[] identities;
    uint256[] losses;
    function setUp() public {
        token = new ReserveTestToken(); pool = new ReserveHarness(token);
        token.mint(address(this), 1000 ether);
        pool.contribute(ALICE, 100 ether); pool.contribute(BOB, 300 ether);
        requests.push(bytes32(uint256(11))); requests.push(bytes32(uint256(12)));
        identities.push(ALICE); identities.push(BOB);
    }
    function testExitNeedsNoRelayAndCannotWithdrawAllocatedRestoration() public {
        losses.push(40 ether); losses.push(60 ether);
        pool.allocate(requests, identities, losses);
        assertEq(pool.availableReserve(), 300 ether);
        assertEq(pool.redeem(ALICE, 100 ether), 75 ether);
        assertEq(pool.redeem(BOB, 300 ether), 225 ether);
        assertEq(token.balanceOf(address(pool)), 100 ether);
        assertEq(pool.withdraw(requests[0], ALICE), 40 ether);
        assertEq(pool.withdraw(requests[1], BOB), 60 ether);
        assertEq(token.balanceOf(address(pool)), 0);
        vm.expectRevert(RecourseReserveAccounting.InvalidReserveAccounting.selector);
        pool.withdraw(requests[0], ALICE);
    }
    function testUnderfundingIsProRataAndNewContributionsDoNotReviveExhaustedShares() public {
        losses.push(400 ether); losses.push(1200 ether);
        pool.allocate(requests, identities, losses);
        assertEq(pool.availableReserve(), 0);
        assertEq(pool.allocatedRestorations(), 400 ether);
        assertEq(pool.contribute(ALICE, 50 ether), 50 ether);
        assertEq(pool.reserveGeneration(), 1);
        vm.expectRevert(RecourseReserveAccounting.InvalidReserveAccounting.selector);
        pool.redeem(BOB, 300 ether);
        assertEq(pool.redeem(ALICE, 50 ether), 50 ether);
        assertEq(pool.withdraw(requests[0], ALICE), 100 ether);
        assertEq(pool.withdraw(requests[1], BOB), 300 ether);
    }
    function testDuplicateAndForeignIdentityCannotConsumeAllocation() public {
        losses.push(40 ether); losses.push(60 ether);
        requests[1] = requests[0];
        vm.expectRevert(RecourseReserveAccounting.InvalidReserveAccounting.selector);
        pool.allocate(requests, identities, losses);
        requests[1] = bytes32(uint256(12));
        pool.allocate(requests, identities, losses);
        vm.expectRevert(RecourseReserveAccounting.InvalidReserveAccounting.selector);
        pool.withdraw(requests[0], BOB);
        vm.expectRevert(RecourseReserveAccounting.InvalidReserveAccounting.selector);
        pool.allocate(requests, identities, losses);
    }
    function testFuzzProRataNeverOverallocates(uint128 first, uint128 second) public {
        first = uint128(bound(first, 1, type(uint128).max));
        second = uint128(bound(second, 1, type(uint128).max));
        losses.push(first); losses.push(second);
        pool.allocate(requests, identities, losses);
        (, uint256 a,) = pool.restorationAllocations(requests[0]);
        (, uint256 b,) = pool.restorationAllocations(requests[1]);
        uint256 distributable = uint256(first) + second;
        if (distributable > 400 ether) distributable = 400 ether;
        assertLe(a + b, distributable);
        assertLt(distributable - a - b, 2);
        assertLe(a, first); assertLe(b, second);
    }
    function testDonationCannotInflateSharePriceOrBlockSmallContribution() public {
        token.mint(address(pool), 1000000000 ether);
        assertEq(pool.contribute(ALICE, 1), 1);
        assertEq(pool.accountedBacking(), 400 ether + 1);
        assertEq(pool.redeem(ALICE, 100 ether + 1), 100 ether + 1);
        assertEq(pool.redeem(BOB, 300 ether), 300 ether);
        assertEq(pool.availableReserve(), 1000000000 ether);
    }

}
