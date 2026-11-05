// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/ProvianPoolV3.sol";

/**
 * @title Security pass 2026-10-02 S1-A against DEPLOYED PoolV3 bytecode (FIX 1).
 *
 * The same phantom-contribution exploit as `SecurityPass20261002Pool.t.sol`, run on a fork of Base
 * against a deployed PoolV3 with the real Base USDC, so the control judges the bytecode that is
 * actually live, not a fresh build of the source:
 *
 * SP_POOL=0x68d557e0A7049a8e32908E548556D22bCda1e3D0 (the PoolV3, pre-fix bytecode) — RED
 * SP_POOL=<the PoolV3> (carries de6007ca) — GREEN
 *
 * BASE_RPC_URL=<fork> SP_POOL=<address> forge test --root contracts --match-contract SecurityPass20261002PoolLive -vv
 *
 * The default `SP_POOL` is the pool (the bootstrap admin's nonce-472 CREATE address).
 */
contract SecurityPass20261002PoolLiveTest is Test {
    address internal constant BASE_USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address internal constant RETIRED_UNREFUNDABLE_POOL = 0xb355C79a78DC0F33b7d1EF5dA230CD8097630a84;

    ProvianPoolV3 internal pool;
    IERC20 internal usdc = IERC20(BASE_USDC);

    address internal attacker = makeAddr("sp-live-attacker");
    address internal creator = makeAddr("sp-live-creator");
    address internal target = makeAddr("sp-live-target");
    address internal honestA = makeAddr("sp-live-honest-a");
    address internal honestB = makeAddr("sp-live-honest-b");

    uint256 internal constant THRESHOLD = 1000e6;
    uint256 internal constant PHANTOM = 400e6;
    uint256 internal constant START = 100_000e6;

    function setUp() public {
        vm.createSelectFork(vm.envOr("BASE_RPC_URL", string("https://mainnet.base.org")));
        pool = ProvianPoolV3(vm.envOr("SP_POOL", RETIRED_UNREFUNDABLE_POOL));
        require(address(pool).code.length > 0, "SP_POOL has no code on this fork");
        require(address(pool.usdc()) == BASE_USDC, "SP_POOL is not bound to Base USDC");
        emit log_named_address("pool under test", address(pool));
        address[4] memory funded = [attacker, creator, honestA, honestB];
        for (uint256 i = 0; i < funded.length; i++) {
            deal(BASE_USDC, funded[i], START);
            vm.prank(funded[i]);
            usdc.approve(address(pool), type(uint256).max);
        }
    }

    function test_live_contributeToNeverCreatedPool_reverts() public {
        bytes32 id = keccak256(abi.encode("sp-live-not-created", address(pool)));
        uint256 before = usdc.balanceOf(address(pool));
        vm.prank(attacker);
        vm.expectRevert(ProvianPoolV3.PoolNotFound.selector);
        pool.contribute(id, PHANTOM);
        assertEq(usdc.balanceOf(address(pool)), before, "nothing taken for a pool that does not exist");
    }

    function test_live_phantomContribution_cannotStrandHonestFunds() public {
        bytes32 id = keccak256(abi.encode("sp-live-pre-seeded", address(pool)));
        uint256 poolBefore = usdc.balanceOf(address(pool));

        vm.prank(attacker);
        try pool.contribute(id, PHANTOM) {
            // pre-fix bytecode: accepted — the exploit proceeds below.
        } catch {
            // post-fix bytecode: refused; the honest path settles to the wei.
            vm.prank(creator);
            pool.createPool(id, target, THRESHOLD, block.timestamp + 7 days, ProvianPoolV3.Currency.USDC);
            vm.prank(honestA);
            pool.contribute(id, THRESHOLD);
            vm.prank(creator);
            pool.executePool(id, false);
            assertEq(usdc.balanceOf(address(pool)), poolBefore, "nothing stranded in the pool contract");
            return;
        }

        vm.prank(creator);
        pool.createPool(id, target, THRESHOLD, block.timestamp + 7 days, ProvianPoolV3.Currency.USDC);
        vm.prank(honestA);
        pool.contribute(id, 600e6);
        vm.prank(attacker);
        pool.withdrawContribution(id);
        vm.prank(honestB);
        pool.contribute(id, 800e6);
        vm.prank(creator);
        pool.executePool(id, false);

        uint256 honestPaid = 600e6 + 800e6;
        uint256 honestBack = (usdc.balanceOf(honestA) - (START - 600e6)) + (usdc.balanceOf(honestB) - (START - 800e6));
        assertEq(honestPaid - honestBack, THRESHOLD, "honest contributors must be out exactly the threshold");
        assertEq(usdc.balanceOf(address(pool)), poolBefore, "nothing stranded in the pool contract");
    }

    function test_live_control_realPoolStillAcceptsContributions() public {
        bytes32 id = keccak256(abi.encode("sp-live-real", address(pool)));
        vm.prank(creator);
        pool.createPool(id, target, THRESHOLD, block.timestamp + 7 days, ProvianPoolV3.Currency.USDC);
        vm.prank(honestA);
        pool.contribute(id, 250e6);
        assertEq(pool.contributions(id, honestA), 250e6);
    }
}
