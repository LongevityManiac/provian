// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ProvianX402FeeSettler} from "../src/ProvianX402FeeSettler.sol";

interface IERC20Like {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
}

interface IFiatTokenLike is IERC20Like {
    function DOMAIN_SEPARATOR() external view returns (bytes32);
    function authorizationState(address, bytes32) external view returns (bool);
}

interface IPermit2Like {
    function DOMAIN_SEPARATOR() external view returns (bytes32);
}

interface IX402ProxyLike {
    function WITNESS_TYPE_STRING() external view returns (string memory);
    function WITNESS_TYPEHASH() external view returns (bytes32);
    function PERMIT2() external view returns (address);
}

/// @notice Live-RPC fork suite: the settler against the REAL Base USDC (FiatToken v2.2),
///         the REAL Permit2, the REAL x402ExactPermit2Proxy and the REAL PVT9 token.
///         Run with `BASE_FORK_RPC_URL=https://mainnet.base.org forge test --root contracts
///         --match-contract ProvianX402FeeSettlerFork -vv`. Skips cleanly when the env var is
///         unset. Nothing is broadcast: every transaction runs on the local fork only.
contract ProvianX402FeeSettlerForkTest is Test {
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address constant X402_PROXY = 0x402085c248EeA27D92E8b30b2C58ed07f9E20001;
    address constant PVT = 0x8811441914381143b9408c5C32247367F86F173A;
    address constant OPERATOR = 0xA37fC594E98e951571C771C9e77CDC73f67d3efB;

    bytes32 constant TRANSFER_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );
    bytes4 constant PERMIT2_INVALID_NONCE = 0x756688fe; // Permit2 InvalidNonce()
    bytes4 constant PERMIT2_INVALID_SIGNER = 0x815e1d64; // Permit2 InvalidSigner()
    bytes32 constant TOKEN_PERMISSIONS_TYPEHASH = keccak256("TokenPermissions(address token,uint256 amount)");

    ProvianX402FeeSettler settler;
    uint256 buyerPk = uint256(keccak256("provian.x402.fork.buyer"));
    address buyer;
    address seller = makeAddr("x402ForkSeller");
    bool forked;

    function setUp() public {
        string memory rpc = vm.envOr("BASE_FORK_RPC_URL", string(""));
        if (bytes(rpc).length == 0) return;
        vm.createSelectFork(rpc);
        forked = true;
        buyer = vm.addr(buyerPk);
        settler = new ProvianX402FeeSettler(USDC, OPERATOR, OPERATOR, X402_PROXY, PVT);
    }

    function _requireFork() internal {
        if (!forked) vm.skip(true);
    }

    function test_fork_constants_matchLiveChain() public {
        _requireFork();
        assertEq(block.chainid, 8453, "Base mainnet fork");
        assertEq(IX402ProxyLike(X402_PROXY).PERMIT2(), PERMIT2, "proxy is bound to canonical Permit2");
        assertEq(
            IX402ProxyLike(X402_PROXY).WITNESS_TYPEHASH(),
            keccak256("Witness(address to,uint256 validAfter)"),
            "proxy witness layout == ProvianX402FeeSettler.Witness"
        );
        assertGt(PVT.code.length, 0, "PVT9 deployed");
        assertEq(settler.pvt(), PVT, "settler pinned to live PVT9");
    }

    function test_fork_settleWithAuthorization_realUsdc() public {
        _requireFork();
        uint256 value = 2_500_000; // $2.50
        uint256 fee = 10_000; // $0.01
        deal(USDC, buyer, 10e6);
        assertEq(IERC20Like(USDC).balanceOf(buyer), 10e6, "deal(USDC) took");

        vm.prank(seller);
        IERC20Like(USDC).approve(address(settler), 1e6);

        bytes32 nonce = keccak256("provian.fork.3009.nonce");
        uint256 validBefore = block.timestamp + 600;
        bytes32 structHash =
            keccak256(abi.encode(TRANSFER_WITH_AUTHORIZATION_TYPEHASH, buyer, seller, value, uint256(0), validBefore, nonce));
        // Real Base USDC domain: name "USD Coin", version "2", chainId 8453, verifyingContract USDC.
        bytes32 expectedDomain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("USD Coin")),
                keccak256(bytes("2")),
                uint256(8453),
                USDC
            )
        );
        assertEq(IFiatTokenLike(USDC).DOMAIN_SEPARATOR(), expectedDomain, "USDC domain");
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(buyerPk, keccak256(abi.encodePacked("\x19\x01", expectedDomain, structHash)));

        uint256 feeBefore = IERC20Like(USDC).balanceOf(OPERATOR);
        vm.prank(OPERATOR);
        settler.settleWithAuthorization(buyer, seller, value, 0, validBefore, nonce, abi.encodePacked(r, s, v), fee);

        assertEq(IERC20Like(USDC).balanceOf(buyer), 10e6 - value, "buyer debited");
        assertEq(IERC20Like(USDC).balanceOf(seller), value - fee, "seller net");
        assertEq(IERC20Like(USDC).balanceOf(OPERATOR) - feeBefore, fee, "fee to feeRecipient");
        assertEq(IERC20Like(USDC).balanceOf(address(settler)), 0, "settler holds nothing");
        assertTrue(IFiatTokenLike(USDC).authorizationState(buyer, nonce), "authorization consumed");

        // Replay on the real token: refused, no second fee.
        vm.prank(OPERATOR);
        vm.expectRevert(bytes("FiatTokenV2: authorization is used or canceled"));
        settler.settleWithAuthorization(buyer, seller, value, 0, validBefore, nonce, abi.encodePacked(r, s, v), fee);
        assertEq(IERC20Like(USDC).balanceOf(OPERATOR) - feeBefore, fee, "no second fee");
    }

    function test_fork_settleWithPermit2_realPvtThroughRealProxy() public {
        _requireFork();
        uint256 amount = 5e18; // 5 PVT
        uint256 fee = 20_000; // $0.02
        deal(PVT, buyer, 100e18);
        assertEq(IERC20Like(PVT).balanceOf(buyer), 100e18, "deal(PVT) took");
        deal(USDC, seller, 1e6); // the seller's fee float

        vm.prank(buyer);
        IERC20Like(PVT).approve(PERMIT2, type(uint256).max);
        vm.prank(seller);
        IERC20Like(USDC).approve(address(settler), 1e6);

        ProvianX402FeeSettler.PermitTransferFrom memory permit = ProvianX402FeeSettler.PermitTransferFrom({
            permitted: ProvianX402FeeSettler.TokenPermissions({token: PVT, amount: amount}),
            nonce: uint256(keccak256("provian.fork.permit2.nonce")),
            deadline: block.timestamp + 600
        });
        ProvianX402FeeSettler.Witness memory witness = ProvianX402FeeSettler.Witness({to: seller, validAfter: 0});
        bytes memory sig = _signPermitWitness(permit, witness);

        uint256 feeBefore = IERC20Like(USDC).balanceOf(OPERATOR);
        // The settler (not the buyer, not the proxy's deployer) calls the live proxy's settle.
        vm.prank(OPERATOR);
        settler.settleWithPermit2(permit, buyer, witness, sig, fee);

        assertEq(IERC20Like(PVT).balanceOf(seller), amount, "seller received PVT via real proxy + Permit2");
        assertEq(IERC20Like(PVT).balanceOf(buyer), 100e18 - amount, "buyer debited PVT");
        assertEq(IERC20Like(USDC).balanceOf(seller), 1e6 - fee, "seller paid the USDC fee");
        assertEq(IERC20Like(USDC).balanceOf(OPERATOR) - feeBefore, fee, "fee to feeRecipient");
        assertEq(IERC20Like(PVT).balanceOf(address(settler)), 0);
        assertEq(IERC20Like(USDC).balanceOf(address(settler)), 0);

        // Replay: Permit2's unordered nonce is spent; refused, no second fee.
        vm.prank(OPERATOR);
        vm.expectRevert(PERMIT2_INVALID_NONCE);
        settler.settleWithPermit2(permit, buyer, witness, sig, fee);
        assertEq(IERC20Like(USDC).balanceOf(OPERATOR) - feeBefore, fee, "no second fee");
    }

    /// RED on the live stack: a Permit2 signature naming a different recipient cannot be
    /// redirected to `seller` (the witness binds `to`), so no fee moves.
    function test_fork_settleWithPermit2_redirectedWitness_revertsNoFee() public {
        _requireFork();
        deal(PVT, buyer, 100e18);
        deal(USDC, seller, 1e6);
        vm.prank(buyer);
        IERC20Like(PVT).approve(PERMIT2, type(uint256).max);
        vm.prank(seller);
        IERC20Like(USDC).approve(address(settler), 1e6);

        ProvianX402FeeSettler.PermitTransferFrom memory permit = ProvianX402FeeSettler.PermitTransferFrom({
            permitted: ProvianX402FeeSettler.TokenPermissions({token: PVT, amount: 1e18}),
            nonce: 42,
            deadline: block.timestamp + 600
        });
        bytes memory sig =
            _signPermitWitness(permit, ProvianX402FeeSettler.Witness({to: makeAddr("someoneElse"), validAfter: 0}));

        uint256 feeBefore = IERC20Like(USDC).balanceOf(OPERATOR);
        vm.prank(OPERATOR);
        vm.expectRevert(PERMIT2_INVALID_SIGNER);
        settler.settleWithPermit2(
            permit, buyer, ProvianX402FeeSettler.Witness({to: seller, validAfter: 0}), sig, 1_000
        );
        assertEq(IERC20Like(USDC).balanceOf(OPERATOR), feeBefore, "no fee moved");
        assertEq(IERC20Like(PVT).balanceOf(seller), 0);
    }

    function _signPermitWitness(
        ProvianX402FeeSettler.PermitTransferFrom memory permit,
        ProvianX402FeeSettler.Witness memory witness
    ) internal view returns (bytes memory) {
        // The exact type string, read from the live proxy rather than transcribed.
        string memory witnessTypeString = IX402ProxyLike(X402_PROXY).WITNESS_TYPE_STRING();
        bytes32 permitWitnessTypehash = keccak256(
            abi.encodePacked(
                "PermitWitnessTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline,",
                witnessTypeString
            )
        );
        bytes32 witnessHash =
            keccak256(abi.encode(IX402ProxyLike(X402_PROXY).WITNESS_TYPEHASH(), witness.to, witness.validAfter));
        bytes32 tokenPermissionsHash =
            keccak256(abi.encode(TOKEN_PERMISSIONS_TYPEHASH, permit.permitted.token, permit.permitted.amount));
        bytes32 structHash = keccak256(
            abi.encode(
                permitWitnessTypehash, tokenPermissionsHash, X402_PROXY, permit.nonce, permit.deadline, witnessHash
            )
        );
        bytes32 domain = IPermit2Like(PERMIT2).DOMAIN_SEPARATOR();
        bytes32 expectedDomain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("Permit2")),
                uint256(8453),
                PERMIT2
            )
        );
        require(domain == expectedDomain, "Permit2 domain mismatch");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(buyerPk, keccak256(abi.encodePacked("\x19\x01", domain, structHash)));
        return abi.encodePacked(r, s, v);
    }
}
