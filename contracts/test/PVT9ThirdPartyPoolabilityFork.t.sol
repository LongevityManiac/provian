// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";
import {ProvianPVT9} from "../src/ProvianPVT9.sol";
import {IERC20} from "../src/interfaces/IERC20.sol";

/**
 * PVT IS FREELY POOLABLE BY A THIRD PARTY — REHEARSED AGAINST THE REAL DEPLOYMENT.
 *
 * The kernel is FINAL, so "can an unaffiliated market maker create and use a PVT/USDC
 * market without Provian's cooperation?" is a question about a PERMANENT property. This
 * suite is the executable answer, kept so the property cannot silently stop being true
 * (e.g. if a future institution contract is granted a transfer-adjacent hook, or a
 * successor token is introduced and quietly assumed to behave the same way).
 *
 * This fork reads the live kernel address from config/pvt9-base.json. The local
 * kernel suite separately exercises the unchanged source. The circulation proof
 * below uses deployed bytecode and ordinary secondary transfers only.
 *
 * WHAT THE SOURCE AUDIT FOUND (all ABSENT, so all four venues below must work):
 *   - no transfer hook / `_update` / `_before`|`_afterTokenTransfer` — `_transfer` is six
 *     lines and reads NO policy state, and the contract inherits nothing, so there is no
 *     base hook to override either;
 *   - no allowlist, blocklist or denylist; no max-transfer or max-balance;
 *   - no fee-on-transfer, reflection, or rebase — `totalSupply` moves only in mint/burn;
 *   - no restriction on contract (non-EOA) recipients;
 *   - `administrativeHold` gates ONLY the two settlement entrypoints (see the hold test).
 *
 * Everything is done by THIRD_PARTY, asserted unprivileged in setUp. Its PVT arrives via
 * an ordinary secondary transfer from a real holder, never a mint.
 *
 *   forge test --root contracts --match-contract PVT9ThirdPartyPoolabilityFork -vv
 *
 * chainId-8453 fork suite: needs a Base RPC (BASE_RPC_URL), like its sibling fork tests.
 */

interface IUniV3Factory {
    function createPool(address tokenA, address tokenB, uint24 fee) external returns (address);
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address);
}

interface IUniV3Pool {
    function initialize(uint160 sqrtPriceX96) external;
}

interface INonfungiblePositionManager {
    struct MintParams {
        address token0;
        address token1;
        uint24 fee;
        int24 tickLower;
        int24 tickUpper;
        uint256 amount0Desired;
        uint256 amount1Desired;
        uint256 amount0Min;
        uint256 amount1Min;
        address recipient;
        uint256 deadline;
    }

    struct DecreaseLiquidityParams {
        uint256 tokenId;
        uint128 liquidity;
        uint256 amount0Min;
        uint256 amount1Min;
        uint256 deadline;
    }

    struct CollectParams {
        uint256 tokenId;
        address recipient;
        uint128 amount0Max;
        uint128 amount1Max;
    }

    function mint(MintParams calldata)
        external
        payable
        returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1);
    function decreaseLiquidity(DecreaseLiquidityParams calldata)
        external
        payable
        returns (uint256 amount0, uint256 amount1);
    function collect(CollectParams calldata) external payable returns (uint256 amount0, uint256 amount1);
}

interface ISwapRouter02 {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata) external payable returns (uint256 amountOut);
}

interface IUniV2Factory {
    function createPair(address, address) external returns (address);
    function getPair(address, address) external view returns (address);
}

interface IUniV2Router {
    function addLiquidity(
        address tokenA,
        address tokenB,
        uint256 amountADesired,
        uint256 amountBDesired,
        uint256 amountAMin,
        uint256 amountBMin,
        address to,
        uint256 deadline
    ) external returns (uint256, uint256, uint256);
    function swapExactTokensForTokens(uint256, uint256, address[] calldata, address, uint256)
        external
        returns (uint256[] memory);
    function removeLiquidity(address, address, uint256, uint256, uint256, address, uint256)
        external
        returns (uint256, uint256);
}

interface IAerodromeFactory {
    function createPool(address tokenA, address tokenB, bool stable) external returns (address);
    function getPool(address tokenA, address tokenB, bool stable) external view returns (address);
}

interface IAerodromeRouter {
    struct Route {
        address from;
        address to;
        bool stable;
        address factory;
    }

    function addLiquidity(
        address tokenA,
        address tokenB,
        bool stable,
        uint256 amountADesired,
        uint256 amountBDesired,
        uint256 amountAMin,
        uint256 amountBMin,
        address to,
        uint256 deadline
    ) external returns (uint256, uint256, uint256);
    function swapExactTokensForTokens(uint256, uint256, Route[] calldata, address, uint256)
        external
        returns (uint256[] memory);
    function removeLiquidity(address, address, bool, uint256, uint256, uint256, address, uint256)
        external
        returns (uint256, uint256);
}

contract PVT9ThirdPartyPoolabilityForkTest is Test {
    address internal PVT9;
    address internal constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;

    /// A current holder read from the live epoch policy; fork-only secondary transfer.
    address internal PVT_HOLDER;
    /// Uniswap V3 USDC/WETH pool — deep USDC, used purely as a fork faucet.
    address internal constant USDC_WHALE = 0xd0b53D9277642d899DF5C87A3966A349A798F224;

    address internal constant V3_FACTORY = 0x33128a8fC17869897dcE68Ed026d694621f6FDfD;
    address internal constant V3_POSITION_MANAGER = 0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1;
    address internal constant V3_ROUTER = 0x2626664c2603336E57B271c5C0b26F421741e481;
    address internal constant V2_FACTORY = 0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6;
    address internal constant V2_ROUTER = 0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24;
    address internal constant AERO_FACTORY = 0x420DD381b31aEf6683db6B902084cB0FFECe40Da;
    address internal constant AERO_ROUTER = 0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43;

    /// An address with no Provian relationship whatsoever.
    address internal constant THIRD_PARTY = address(0xBEEFCAFE);

    uint24 internal constant V3_FEE = 3000;
    int24 internal constant FULL_RANGE_LOWER = -887220;
    int24 internal constant FULL_RANGE_UPPER = 887220;

    /// USDC sorts BELOW PVT9, so token0 = USDC (6dp) and token1 = PVT (18dp).
    /// price(token1/token0) = 1e18/1e6 = 1e12 → sqrt = 1e6 → sqrtPriceX96 = 1e6 * 2**96.
    uint160 internal constant SQRT_PRICE_1_PVT_PER_USDC = 79228162514264337593543950336000000;

    uint256 internal constant PVT_SEED = 20e18;
    uint256 internal constant USDC_SEED = 20e6;
    uint256 internal constant PVT_FUNDING = 60e18;
    uint256 internal constant USDC_FUNDING = 200e6;

    ProvianPVT9 internal kernel;

    function setUp() public {
        vm.createSelectFork(vm.envOr("BASE_RPC_URL", string("https://mainnet.base.org")));
        require(block.chainid == 8453, "Fork tests require Base mainnet (chainId 8453)");
        PVT9 = vm.parseJsonAddress(vm.readFile("../config/pvt9-base.json"), ".assets.pvt9.address");
        kernel = ProvianPVT9(PVT9);
        PVT_HOLDER = kernel.getEpochPolicy(kernel.lastOpenedEpoch()).provianTreasury;
        assertGe(kernel.balanceOf(PVT_HOLDER), PVT_FUNDING, "live holder cannot fund the fork proof");

        // The token ordering every sqrtPrice below depends on.
        require(USDC < PVT9, "expected USDC to sort as token0");

        // Prove the actor is unprivileged BEFORE using it, so a green run can never be an
        // artifact of having accidentally rehearsed as the admin or the minter.
        assertTrue(THIRD_PARTY != kernel.BOOTSTRAP_ADMIN(), "third party must not be bootstrap admin");
        assertTrue(THIRD_PARTY != kernel.operationalMinter(), "third party must not be operational minter");

        vm.deal(THIRD_PARTY, 10 ether);

        // Ordinary secondary transfer from a real holder — no mint, no relay, no admin.
        vm.prank(PVT_HOLDER);
        kernel.transfer(THIRD_PARTY, PVT_FUNDING);

        vm.prank(USDC_WHALE);
        IERC20(USDC).transfer(THIRD_PARTY, USDC_FUNDING);

        assertEq(kernel.balanceOf(THIRD_PARTY), PVT_FUNDING, "PVT funding failed");
        assertEq(IERC20(USDC).balanceOf(THIRD_PARTY), USDC_FUNDING, "USDC funding failed");
    }

    // -----------------------------------------------------------------------
    // NEGATIVE CONTROL
    // -----------------------------------------------------------------------

    /// A suite that has only ever been seen GREEN proves nothing: it would read the same
    /// if PVT were transfer-restricted and the harness simply could not tell. So drive the
    /// IDENTICAL V3 path with PVT's transfer entrypoints mocked to revert, and require the
    /// seed to FAIL. This is what makes every pass below carry information.
    function test_negativeControl_transferRestrictedTokenCannotSeedAPool() public {
        vm.startPrank(THIRD_PARTY);
        kernel.approve(V3_POSITION_MANAGER, type(uint256).max);
        IERC20(USDC).approve(V3_POSITION_MANAGER, type(uint256).max);
        address pool = IUniV3Factory(V3_FACTORY).createPool(PVT9, USDC, V3_FEE);
        IUniV3Pool(pool).initialize(SQRT_PRICE_1_PVT_PER_USDC);
        vm.stopPrank();

        // Exactly the restriction the source audit looked for and did not find.
        vm.mockCallRevert(PVT9, abi.encodeWithSelector(ProvianPVT9.transfer.selector), abi.encode("Restricted"));
        vm.mockCallRevert(PVT9, abi.encodeWithSelector(ProvianPVT9.transferFrom.selector), abi.encode("Restricted"));

        vm.prank(THIRD_PARTY);
        vm.expectRevert();
        INonfungiblePositionManager(V3_POSITION_MANAGER).mint(_fullRangeMintParams());

        vm.clearMockedCalls();
        console2.log("NEGATIVE CONTROL: transfer-restricted token correctly FAILED to seed a V3 pool");
    }

    // -----------------------------------------------------------------------
    // UNISWAP V3
    // -----------------------------------------------------------------------

    function test_uniswapV3_create_add_swapBothWays_remove() public {
        vm.startPrank(THIRD_PARTY);
        kernel.approve(V3_POSITION_MANAGER, type(uint256).max);
        IERC20(USDC).approve(V3_POSITION_MANAGER, type(uint256).max);
        kernel.approve(V3_ROUTER, type(uint256).max);
        IERC20(USDC).approve(V3_ROUTER, type(uint256).max);

        // 1. CREATE — initialize() succeeding is also proof the pool did not already exist.
        address pool = IUniV3Factory(V3_FACTORY).createPool(PVT9, USDC, V3_FEE);
        assertTrue(pool != address(0), "V3 createPool returned zero");
        IUniV3Pool(pool).initialize(SQRT_PRICE_1_PVT_PER_USDC);
        console2.log("V3 CREATE  : ok, pool =", pool);

        // 2. ADD two-sided liquidity.
        (uint256 tokenId, uint128 liquidity, uint256 usdcIn, uint256 pvtIn) =
            INonfungiblePositionManager(V3_POSITION_MANAGER).mint(_fullRangeMintParams());
        assertGt(liquidity, 0, "V3 mint produced no liquidity");
        assertGt(usdcIn, 0, "V3 mint consumed no USDC");
        assertGt(pvtIn, 0, "V3 mint consumed no PVT");
        console2.log("V3 ADD     : ok, USDC in / PVT in", usdcIn, pvtIn);

        // 3a. SWAP USDC -> PVT.
        uint256 pvtBefore = kernel.balanceOf(THIRD_PARTY);
        uint256 pvtOut = ISwapRouter02(V3_ROUTER).exactInputSingle(
            ISwapRouter02.ExactInputSingleParams({
                tokenIn: USDC,
                tokenOut: PVT9,
                fee: V3_FEE,
                recipient: THIRD_PARTY,
                amountIn: 5e6,
                amountOutMinimum: 0,
                sqrtPriceLimitX96: 0
            })
        );
        assertGt(pvtOut, 0, "V3 USDC->PVT returned nothing");
        assertEq(kernel.balanceOf(THIRD_PARTY) - pvtBefore, pvtOut, "V3 PVT delta != router-reported out");
        console2.log("V3 SWAP in : ok, 5 USDC -> PVT wei", pvtOut);

        // 3b. SWAP PVT -> USDC.
        uint256 usdcBefore = IERC20(USDC).balanceOf(THIRD_PARTY);
        uint256 usdcOut = ISwapRouter02(V3_ROUTER).exactInputSingle(
            ISwapRouter02.ExactInputSingleParams({
                tokenIn: PVT9,
                tokenOut: USDC,
                fee: V3_FEE,
                recipient: THIRD_PARTY,
                amountIn: 5e18,
                amountOutMinimum: 0,
                sqrtPriceLimitX96: 0
            })
        );
        assertGt(usdcOut, 0, "V3 PVT->USDC returned nothing");
        assertEq(IERC20(USDC).balanceOf(THIRD_PARTY) - usdcBefore, usdcOut, "V3 USDC delta != router-reported out");
        console2.log("V3 SWAP out: ok, 5 PVT -> USDC units", usdcOut);

        // 4. REMOVE.
        INonfungiblePositionManager(V3_POSITION_MANAGER).decreaseLiquidity(
            INonfungiblePositionManager.DecreaseLiquidityParams({
                tokenId: tokenId,
                liquidity: liquidity,
                amount0Min: 0,
                amount1Min: 0,
                deadline: block.timestamp + 1
            })
        );
        (uint256 usdcBack, uint256 pvtBack) = INonfungiblePositionManager(V3_POSITION_MANAGER).collect(
            INonfungiblePositionManager.CollectParams({
                tokenId: tokenId,
                recipient: THIRD_PARTY,
                amount0Max: type(uint128).max,
                amount1Max: type(uint128).max
            })
        );
        assertGt(usdcBack, 0, "V3 collect returned no USDC");
        assertGt(pvtBack, 0, "V3 collect returned no PVT");
        console2.log("V3 REMOVE  : ok, USDC out / PVT out", usdcBack, pvtBack);

        vm.stopPrank();
    }

    // -----------------------------------------------------------------------
    // UNISWAP V2
    // -----------------------------------------------------------------------

    function test_uniswapV2_create_add_swapBothWays_remove() public {
        vm.startPrank(THIRD_PARTY);
        kernel.approve(V2_ROUTER, type(uint256).max);
        IERC20(USDC).approve(V2_ROUTER, type(uint256).max);

        address pair = IUniV2Factory(V2_FACTORY).getPair(PVT9, USDC);
        if (pair == address(0)) pair = IUniV2Factory(V2_FACTORY).createPair(PVT9, USDC);
        assertTrue(pair != address(0), "V2 createPair returned zero");
        console2.log("V2 CREATE  : ok, pair =", pair);

        (uint256 pvtIn, uint256 usdcIn, uint256 lp) = IUniV2Router(V2_ROUTER).addLiquidity(
            PVT9, USDC, PVT_SEED, USDC_SEED, 0, 0, THIRD_PARTY, block.timestamp + 1
        );
        assertGt(lp, 0, "V2 addLiquidity minted no LP");
        console2.log("V2 ADD     : ok, PVT in / USDC in", pvtIn, usdcIn);

        uint256[] memory inLeg =
            IUniV2Router(V2_ROUTER).swapExactTokensForTokens(5e6, 0, _path(USDC, PVT9), THIRD_PARTY, block.timestamp + 1);
        assertGt(inLeg[1], 0, "V2 USDC->PVT returned nothing");
        console2.log("V2 SWAP in : ok, 5 USDC -> PVT wei", inLeg[1]);

        uint256[] memory outLeg = IUniV2Router(V2_ROUTER).swapExactTokensForTokens(
            5e18, 0, _path(PVT9, USDC), THIRD_PARTY, block.timestamp + 1
        );
        assertGt(outLeg[1], 0, "V2 PVT->USDC returned nothing");
        console2.log("V2 SWAP out: ok, 5 PVT -> USDC units", outLeg[1]);

        IERC20(pair).approve(V2_ROUTER, type(uint256).max);
        (uint256 pvtBack, uint256 usdcBack) =
            IUniV2Router(V2_ROUTER).removeLiquidity(PVT9, USDC, lp, 0, 0, THIRD_PARTY, block.timestamp + 1);
        assertGt(pvtBack, 0, "V2 removeLiquidity returned no PVT");
        assertGt(usdcBack, 0, "V2 removeLiquidity returned no USDC");
        console2.log("V2 REMOVE  : ok, PVT out / USDC out", pvtBack, usdcBack);

        vm.stopPrank();
    }

    // -----------------------------------------------------------------------
    // AERODROME (volatile pool)
    // -----------------------------------------------------------------------

    function test_aerodrome_create_add_swapBothWays_remove() public {
        vm.startPrank(THIRD_PARTY);
        kernel.approve(AERO_ROUTER, type(uint256).max);
        IERC20(USDC).approve(AERO_ROUTER, type(uint256).max);

        address pool = IAerodromeFactory(AERO_FACTORY).getPool(PVT9, USDC, false);
        if (pool == address(0)) pool = IAerodromeFactory(AERO_FACTORY).createPool(PVT9, USDC, false);
        assertTrue(pool != address(0), "Aerodrome createPool returned zero");
        console2.log("AERO CREATE: ok, pool =", pool);

        (uint256 pvtIn, uint256 usdcIn, uint256 lp) = IAerodromeRouter(AERO_ROUTER).addLiquidity(
            PVT9, USDC, false, PVT_SEED, USDC_SEED, 0, 0, THIRD_PARTY, block.timestamp + 1
        );
        assertGt(lp, 0, "Aerodrome addLiquidity minted no LP");
        console2.log("AERO ADD   : ok, PVT in / USDC in", pvtIn, usdcIn);

        uint256[] memory inLeg = IAerodromeRouter(AERO_ROUTER).swapExactTokensForTokens(
            5e6, 0, _route(USDC, PVT9), THIRD_PARTY, block.timestamp + 1
        );
        assertGt(inLeg[1], 0, "Aerodrome USDC->PVT returned nothing");
        console2.log("AERO SWAP i: ok, 5 USDC -> PVT wei", inLeg[1]);

        uint256[] memory outLeg = IAerodromeRouter(AERO_ROUTER).swapExactTokensForTokens(
            5e18, 0, _route(PVT9, USDC), THIRD_PARTY, block.timestamp + 1
        );
        assertGt(outLeg[1], 0, "Aerodrome PVT->USDC returned nothing");
        console2.log("AERO SWAP o: ok, 5 PVT -> USDC units", outLeg[1]);

        IERC20(pool).approve(AERO_ROUTER, type(uint256).max);
        (uint256 pvtBack, uint256 usdcBack) = IAerodromeRouter(AERO_ROUTER).removeLiquidity(
            PVT9, USDC, false, lp, 0, 0, THIRD_PARTY, block.timestamp + 1
        );
        assertGt(pvtBack, 0, "Aerodrome removeLiquidity returned no PVT");
        assertGt(usdcBack, 0, "Aerodrome removeLiquidity returned no USDC");
        console2.log("AERO REMOVE: ok, PVT out / USDC out", pvtBack, usdcBack);

        vm.stopPrank();
    }

    // -----------------------------------------------------------------------
    // ERC-20 CONFORMANCE a router or market maker depends on
    // -----------------------------------------------------------------------

    function test_erc20ConformanceAndNoFeeOnTransfer() public {
        assertEq(kernel.decimals(), 18, "decimals != 18");

        vm.startPrank(THIRD_PARTY);
        assertTrue(kernel.transfer(address(0xD00D), 0), "zero-value transfer did not return true");
        assertTrue(kernel.approve(address(0xD00D), 0), "zero approve did not return true");
        assertTrue(kernel.approve(address(0xD00D), 1e18), "approve did not return true");
        assertEq(kernel.allowance(THIRD_PARTY, address(0xD00D)), 1e18, "allowance not set");
        vm.stopPrank();

        vm.prank(address(0xD00D));
        assertTrue(kernel.transferFrom(THIRD_PARTY, address(0xD00D), 0), "zero transferFrom did not return true");

        // Contract recipients are not special-cased.
        vm.prank(THIRD_PARTY);
        assertTrue(kernel.transfer(V3_FACTORY, 1e18), "transfer to a contract failed");
        assertEq(kernel.balanceOf(V3_FACTORY), 1e18, "contract recipient did not receive");

        // No fee-on-transfer, no reflection, no rebase.
        uint256 senderBefore = kernel.balanceOf(THIRD_PARTY);
        uint256 supplyBefore = kernel.totalSupply();
        vm.prank(THIRD_PARTY);
        kernel.transfer(address(0xFEE5), 7e18);
        assertEq(senderBefore - kernel.balanceOf(THIRD_PARTY), 7e18, "sender debited != amount (fee-on-transfer)");
        assertEq(kernel.balanceOf(address(0xFEE5)), 7e18, "recipient credited != amount (fee-on-transfer)");
        assertEq(kernel.totalSupply(), supplyBefore, "totalSupply moved on a transfer (rebase/reflection)");
    }

    /// `administrativeHold`'s SCOPE, proven rather than inferred from its name. It is
    /// applied by `whenNotHeld` to exactly two functions — `settleStandardPEBatch` and
    /// `settleGenesisPEBatch` — so it halts ISSUANCE, never CIRCULATION. That distinction
    /// is the one a market maker is actually exposed to, so it is asserted, not assumed.
    function test_administrativeHoldDoesNotGateTransfersOrSwaps() public {
        vm.startPrank(THIRD_PARTY);
        kernel.approve(V3_POSITION_MANAGER, type(uint256).max);
        IERC20(USDC).approve(V3_POSITION_MANAGER, type(uint256).max);
        IERC20(USDC).approve(V3_ROUTER, type(uint256).max);
        address pool = IUniV3Factory(V3_FACTORY).createPool(PVT9, USDC, V3_FEE);
        IUniV3Pool(pool).initialize(SQRT_PRICE_1_PVT_PER_USDC);
        INonfungiblePositionManager(V3_POSITION_MANAGER).mint(_fullRangeMintParams());
        vm.stopPrank();

        vm.prank(kernel.BOOTSTRAP_ADMIN());
        kernel.placeAdministrativeHold();
        assertTrue(kernel.administrativeHold(), "hold did not latch");

        // Circulation is untouched: a plain transfer still settles.
        vm.prank(THIRD_PARTY);
        assertTrue(kernel.transfer(address(0xABCD), 1e18), "transfer blocked under administrative hold");
        assertEq(kernel.balanceOf(address(0xABCD)), 1e18, "transfer under hold did not settle");

        // And so does a swap against the live pool.
        vm.prank(THIRD_PARTY);
        uint256 pvtOut = ISwapRouter02(V3_ROUTER).exactInputSingle(
            ISwapRouter02.ExactInputSingleParams({
                tokenIn: USDC,
                tokenOut: PVT9,
                fee: V3_FEE,
                recipient: THIRD_PARTY,
                amountIn: 1e6,
                amountOutMinimum: 0,
                sqrtPriceLimitX96: 0
            })
        );
        assertGt(pvtOut, 0, "swap blocked under administrative hold");
        console2.log("HOLD SCOPE : transfers and swaps UNAFFECTED under hold; PVT out =", pvtOut);
    }

    // -----------------------------------------------------------------------
    // helpers
    // -----------------------------------------------------------------------

    function _fullRangeMintParams() internal view returns (INonfungiblePositionManager.MintParams memory) {
        return INonfungiblePositionManager.MintParams({
            token0: USDC,
            token1: PVT9,
            fee: V3_FEE,
            tickLower: FULL_RANGE_LOWER,
            tickUpper: FULL_RANGE_UPPER,
            amount0Desired: USDC_SEED,
            amount1Desired: PVT_SEED,
            amount0Min: 0,
            amount1Min: 0,
            recipient: THIRD_PARTY,
            deadline: block.timestamp + 1
        });
    }

    function _path(address from, address to) internal pure returns (address[] memory path) {
        path = new address[](2);
        path[0] = from;
        path[1] = to;
    }

    function _route(address from, address to) internal pure returns (IAerodromeRouter.Route[] memory route) {
        route = new IAerodromeRouter.Route[](1);
        route[0] = IAerodromeRouter.Route({from: from, to: to, stable: false, factory: AERO_FACTORY});
    }
}
