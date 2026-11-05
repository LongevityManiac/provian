// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ProvianX402FeeSettler} from "../src/ProvianX402FeeSettler.sol";

/// @dev Minimal ERC-20 (18-decimal PVT stand-in).
contract X402MockERC20 {
    string public name;
    uint8 public immutable decimals;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(string memory name_, uint8 decimals_) {
        name = name_;
        decimals = decimals_;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) public virtual returns (bool) {
        uint256 a = allowance[from][msg.sender];
        require(a >= amount, "ERC20: transfer amount exceeds allowance");
        if (a != type(uint256).max) allowance[from][msg.sender] = a - amount;
        require(balanceOf[from] >= amount, "ERC20: transfer amount exceeds balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/// @dev USDC stand-in with FiatToken v2.2's EIP-3009 BYTES-signature overload: real ECDSA
///      over the EIP-712 TransferWithAuthorization typed data, single-use nonces
///      (authorizationState), validity window. `transferFromMode` lets a test make
///      transferFrom return false (1) or return no data (2) to exercise the settler's
///      safe-transfer handling.
contract X402MockUSDC is X402MockERC20 {
    bytes32 public constant TRANSFER_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );
    bytes32 public immutable DOMAIN_SEPARATOR;
    mapping(address => mapping(bytes32 => bool)) public authorizationState;
    uint8 public transferFromMode;

    constructor() X402MockERC20("USD Coin", 6) {
        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("USD Coin")),
                keccak256(bytes("2")),
                block.chainid,
                address(this)
            )
        );
    }

    function setTransferFromMode(uint8 m) external {
        transferFromMode = m;
    }

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        if (transferFromMode == 1) return false;
        super.transferFrom(from, to, amount);
        if (transferFromMode == 2) {
            assembly {
                return(0, 0)
            }
        }
        return true;
    }

    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes memory signature
    ) external {
        require(block.timestamp > validAfter, "FiatTokenV2: authorization is not yet valid");
        require(block.timestamp < validBefore, "FiatTokenV2: authorization is expired");
        require(!authorizationState[from][nonce], "FiatTokenV2: authorization is used or canceled");
        bytes32 structHash =
            keccak256(abi.encode(TRANSFER_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
        require(signature.length == 65, "FiatTokenV2: invalid signature");
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := mload(add(signature, 0x20))
            s := mload(add(signature, 0x40))
            v := byte(0, mload(add(signature, 0x60)))
        }
        address signer = ecrecover(digest, v, r, s);
        require(signer != address(0) && signer == from, "FiatTokenV2: invalid signature");
        authorizationState[from][nonce] = true;
        require(balanceOf[from] >= value, "ERC20: transfer amount exceeds balance");
        balanceOf[from] -= value;
        balanceOf[to] += value;
    }
}

/// @dev x402ExactPermit2Proxy stand-in. Simplified authority: an ECDSA signature by the
///      owner over (permit, witness, proxy), single-use nonce per owner; then moves the
///      permitted amount owner -> witness.to out of the owner's approval to this proxy.
///      Like the real proxy, it does not restrict msg.sender.
contract X402MockPermit2Proxy {
    mapping(address => mapping(uint256 => bool)) public nonceUsed;

    function digestOf(ProvianX402FeeSettler.PermitTransferFrom memory p, ProvianX402FeeSettler.Witness memory w)
        public
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encode(
                "X402_MOCK_PERMIT2_PROXY",
                p.permitted.token,
                p.permitted.amount,
                p.nonce,
                p.deadline,
                w.to,
                w.validAfter,
                address(this)
            )
        );
    }

    function settle(
        ProvianX402FeeSettler.PermitTransferFrom calldata permit,
        address owner,
        ProvianX402FeeSettler.Witness calldata witness,
        bytes calldata signature
    ) external virtual {
        require(block.timestamp <= permit.deadline, "expired");
        require(block.timestamp >= witness.validAfter, "not yet valid");
        require(!nonceUsed[owner][permit.nonce], "InvalidNonce");
        (bytes32 r, bytes32 s) = (bytes32(signature[0:32]), bytes32(signature[32:64]));
        uint8 v = uint8(signature[64]);
        require(ecrecover(digestOf(permit, witness), v, r, s) == owner, "InvalidSigner");
        nonceUsed[owner][permit.nonce] = true;
        require(X402MockERC20(permit.permitted.token).transferFrom(owner, witness.to, permit.permitted.amount));
    }
}

/// @dev A proxy that accepts the call and delivers NOTHING.
contract X402NonDeliveringProxy {
    function settle(
        ProvianX402FeeSettler.PermitTransferFrom calldata,
        address,
        ProvianX402FeeSettler.Witness calldata,
        bytes calldata
    ) external pure {}
}

contract ProvianX402FeeSettlerTest is Test {
    event FeeSettled(address indexed buyer, address indexed seller, address indexed token, uint256 value, uint256 fee);

    X402MockUSDC usdc;
    X402MockERC20 pvt;
    X402MockPermit2Proxy proxy;
    ProvianX402FeeSettler settler;

    address operator = makeAddr("operator");
    address feeRecipient = makeAddr("feeRecipient");
    address seller = makeAddr("seller");
    address seller2 = makeAddr("seller2");
    address stranger = makeAddr("stranger");
    uint256 buyerPk = 0xB0B;
    address buyer;
    uint256 constant MAX_FEE = 50_000;
    uint256 constant BUYER_USDC = 1_000_000e6;
    uint256 constant SELLER_USDC = 10e6;

    function setUp() public {
        vm.warp(1_800_000_000);
        buyer = vm.addr(buyerPk);
        usdc = new X402MockUSDC();
        pvt = new X402MockERC20("Provian PVT", 18);
        proxy = new X402MockPermit2Proxy();
        settler = new ProvianX402FeeSettler(address(usdc), operator, feeRecipient, address(proxy), address(pvt));

        usdc.mint(buyer, BUYER_USDC);
        pvt.mint(buyer, 1_000_000e18);
        for (uint256 i; i < 2; ++i) {
            address s = i == 0 ? seller : seller2;
            usdc.mint(s, SELLER_USDC);
            vm.prank(s);
            usdc.approve(address(settler), type(uint256).max);
        }
        vm.startPrank(buyer);
        pvt.approve(address(proxy), type(uint256).max);
        usdc.approve(address(proxy), type(uint256).max);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ helpers

    function _sign3009(uint256 pk, address from, address to, uint256 value, bytes32 nonce)
        internal
        view
        returns (bytes memory)
    {
        bytes32 structHash = keccak256(
            abi.encode(
                usdc.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(), from, to, value, uint256(0), block.timestamp + 600, nonce
            )
        );
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(pk, keccak256(abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(), structHash)));
        return abi.encodePacked(r, s, v);
    }

    function _settle3009(address to, uint256 value, bytes32 nonce, bytes memory sig, uint256 fee) internal {
        vm.prank(operator);
        settler.settleWithAuthorization(buyer, to, value, 0, block.timestamp + 600, nonce, sig, fee);
    }

    function _permit(address token, uint256 amount, uint256 nonce)
        internal
        view
        returns (ProvianX402FeeSettler.PermitTransferFrom memory p)
    {
        p = ProvianX402FeeSettler.PermitTransferFrom({
            permitted: ProvianX402FeeSettler.TokenPermissions({token: token, amount: amount}),
            nonce: nonce,
            deadline: block.timestamp + 600
        });
    }

    function _signPermit(
        uint256 pk,
        ProvianX402FeeSettler.PermitTransferFrom memory p,
        ProvianX402FeeSettler.Witness memory w
    ) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, proxy.digestOf(p, w));
        return abi.encodePacked(r, s, v);
    }

    // ------------------------------------------------------------------ constructor

    function test_constructor_setsImmutables() public view {
        assertEq(settler.usdc(), address(usdc));
        assertEq(settler.operator(), operator);
        assertEq(settler.feeRecipient(), feeRecipient);
        assertEq(settler.permit2Proxy(), address(proxy));
        assertEq(settler.pvt(), address(pvt));
        assertEq(settler.MAX_FEE(), 50_000);
    }

    function test_constructor_zeroUsdc_reverts() public {
        vm.expectRevert(ProvianX402FeeSettler.ZeroAddress.selector);
        new ProvianX402FeeSettler(address(0), operator, feeRecipient, address(proxy), address(pvt));
    }

    function test_constructor_zeroOperator_reverts() public {
        vm.expectRevert(ProvianX402FeeSettler.ZeroAddress.selector);
        new ProvianX402FeeSettler(address(usdc), address(0), feeRecipient, address(proxy), address(pvt));
    }

    function test_constructor_zeroFeeRecipient_reverts() public {
        vm.expectRevert(ProvianX402FeeSettler.ZeroAddress.selector);
        new ProvianX402FeeSettler(address(usdc), operator, address(0), address(proxy), address(pvt));
    }

    function test_constructor_zeroProxy_reverts() public {
        vm.expectRevert(ProvianX402FeeSettler.ZeroAddress.selector);
        new ProvianX402FeeSettler(address(usdc), operator, feeRecipient, address(0), address(pvt));
    }

    function test_constructor_zeroPvt_reverts() public {
        vm.expectRevert(ProvianX402FeeSettler.ZeroAddress.selector);
        new ProvianX402FeeSettler(address(usdc), operator, feeRecipient, address(proxy), address(0));
    }

    // ------------------------------------------------------------------ USDC happy path

    function test_settleWithAuthorization_happyPath() public {
        uint256 value = 1e6;
        uint256 fee = 10_000;
        bytes32 nonce = keccak256("n1");
        bytes memory sig = _sign3009(buyerPk, buyer, seller, value, nonce);

        vm.expectEmit(true, true, true, true, address(settler));
        emit FeeSettled(buyer, seller, address(usdc), value, fee);
        _settle3009(seller, value, nonce, sig, fee);

        assertEq(usdc.balanceOf(buyer), BUYER_USDC - value, "buyer debited value");
        assertEq(usdc.balanceOf(seller), SELLER_USDC + value - fee, "seller net = value - fee");
        assertEq(usdc.balanceOf(feeRecipient), fee, "feeRecipient got fee");
        assertEq(usdc.balanceOf(address(settler)), 0, "settler holds nothing");
        assertEq(usdc.balanceOf(operator), 0, "operator gets nothing");
        assertTrue(usdc.authorizationState(buyer, nonce));
    }

    function test_settleWithAuthorization_noReturnDataTransferFrom_succeeds() public {
        usdc.setTransferFromMode(2);
        bytes32 nonce = keccak256("noret");
        _settle3009(seller, 1e6, nonce, _sign3009(buyerPk, buyer, seller, 1e6, nonce), 5_000);
        assertEq(usdc.balanceOf(feeRecipient), 5_000);
    }

    function test_settleWithAuthorization_falseReturningTransferFrom_reverts() public {
        usdc.setTransferFromMode(1);
        bytes32 nonce = keccak256("false");
        bytes memory sig = _sign3009(buyerPk, buyer, seller, 1e6, nonce);
        vm.expectRevert(ProvianX402FeeSettler.FeeTransferFailed.selector);
        _settle3009(seller, 1e6, nonce, sig, 5_000);
        assertEq(usdc.balanceOf(seller), SELLER_USDC, "payment rolled back");
        assertFalse(usdc.authorizationState(buyer, nonce));
    }

    // ------------------------------------------------------------------ Permit2 happy path

    function test_settleWithPermit2_pvt_happyPath() public {
        uint256 amount = 3e18;
        uint256 fee = 20_000;
        ProvianX402FeeSettler.PermitTransferFrom memory p = _permit(address(pvt), amount, 7);
        ProvianX402FeeSettler.Witness memory w = ProvianX402FeeSettler.Witness({to: seller, validAfter: 0});
        bytes memory sig = _signPermit(buyerPk, p, w);

        vm.expectEmit(true, true, true, true, address(settler));
        emit FeeSettled(buyer, seller, address(pvt), amount, fee);
        vm.prank(operator);
        settler.settleWithPermit2(p, buyer, w, sig, fee);

        assertEq(pvt.balanceOf(seller), amount, "seller received PVT");
        assertEq(pvt.balanceOf(buyer), 1_000_000e18 - amount, "buyer debited PVT");
        assertEq(usdc.balanceOf(seller), SELLER_USDC - fee, "seller paid USDC fee");
        assertEq(usdc.balanceOf(feeRecipient), fee, "feeRecipient got USDC fee");
        assertEq(pvt.balanceOf(address(settler)), 0);
        assertEq(usdc.balanceOf(address(settler)), 0);
    }

    function test_settleWithPermit2_usdcToken_happyPath() public {
        ProvianX402FeeSettler.PermitTransferFrom memory p = _permit(address(usdc), 1e6, 8);
        ProvianX402FeeSettler.Witness memory w = ProvianX402FeeSettler.Witness({to: seller, validAfter: 0});
        bytes memory sig = _signPermit(buyerPk, p, w);
        vm.prank(operator);
        settler.settleWithPermit2(p, buyer, w, sig, 1_000);
        assertEq(usdc.balanceOf(seller), SELLER_USDC + 1e6 - 1_000);
        assertEq(usdc.balanceOf(feeRecipient), 1_000);
    }

    // ------------------------------------------------------------------ REDs: operator gate

    function test_settleWithAuthorization_nonOperator_reverts() public {
        bytes32 nonce = keccak256("n");
        bytes memory sig = _sign3009(buyerPk, buyer, seller, 1e6, nonce);
        vm.prank(stranger);
        vm.expectRevert(ProvianX402FeeSettler.NotOperator.selector);
        settler.settleWithAuthorization(buyer, seller, 1e6, 0, block.timestamp + 600, nonce, sig, 1_000);
        // the seller itself is not the operator either
        vm.prank(seller);
        vm.expectRevert(ProvianX402FeeSettler.NotOperator.selector);
        settler.settleWithAuthorization(buyer, seller, 1e6, 0, block.timestamp + 600, nonce, sig, 1_000);
        assertEq(usdc.balanceOf(feeRecipient), 0);
    }

    function test_settleWithPermit2_nonOperator_reverts() public {
        ProvianX402FeeSettler.PermitTransferFrom memory p = _permit(address(pvt), 1e18, 1);
        ProvianX402FeeSettler.Witness memory w = ProvianX402FeeSettler.Witness({to: seller, validAfter: 0});
        bytes memory sig = _signPermit(buyerPk, p, w);
        vm.prank(stranger);
        vm.expectRevert(ProvianX402FeeSettler.NotOperator.selector);
        settler.settleWithPermit2(p, buyer, w, sig, 1_000);
        assertEq(usdc.balanceOf(feeRecipient), 0);
    }

    // ------------------------------------------------------------------ REDs: fee bounds

    function test_settleWithAuthorization_zeroFee_reverts() public {
        bytes32 nonce = keccak256("z");
        bytes memory sig = _sign3009(buyerPk, buyer, seller, 1e6, nonce);
        vm.prank(operator);
        vm.expectRevert(ProvianX402FeeSettler.FeeOutOfRange.selector);
        settler.settleWithAuthorization(buyer, seller, 1e6, 0, block.timestamp + 600, nonce, sig, 0);
    }

    function test_settleWithAuthorization_feeAboveMax_reverts() public {
        bytes32 nonce = keccak256("m");
        bytes memory sig = _sign3009(buyerPk, buyer, seller, 1e6, nonce);
        vm.prank(operator);
        vm.expectRevert(ProvianX402FeeSettler.FeeOutOfRange.selector);
        settler.settleWithAuthorization(buyer, seller, 1e6, 0, block.timestamp + 600, nonce, sig, MAX_FEE + 1);
    }

    function test_settleWithAuthorization_feeAtMax_succeeds() public {
        bytes32 nonce = keccak256("atmax");
        _settle3009(seller, 1e6, nonce, _sign3009(buyerPk, buyer, seller, 1e6, nonce), MAX_FEE);
        assertEq(usdc.balanceOf(feeRecipient), MAX_FEE);
    }

    function test_settleWithAuthorization_feeEqualsValue_reverts() public {
        uint256 value = 10_000;
        bytes32 nonce = keccak256("eq");
        bytes memory sig = _sign3009(buyerPk, buyer, seller, value, nonce);
        vm.prank(operator);
        vm.expectRevert(ProvianX402FeeSettler.FeeNotBelowValue.selector);
        settler.settleWithAuthorization(buyer, seller, value, 0, block.timestamp + 600, nonce, sig, value);
    }

    function test_settleWithAuthorization_feeAboveValue_reverts() public {
        uint256 value = 10_000;
        bytes32 nonce = keccak256("gt");
        bytes memory sig = _sign3009(buyerPk, buyer, seller, value, nonce);
        vm.prank(operator);
        vm.expectRevert(ProvianX402FeeSettler.FeeNotBelowValue.selector);
        settler.settleWithAuthorization(buyer, seller, value, 0, block.timestamp + 600, nonce, sig, value + 1);
    }

    function test_settleWithAuthorization_feeOneBelowValue_succeeds() public {
        uint256 value = 10_000;
        bytes32 nonce = keccak256("lt");
        _settle3009(seller, value, nonce, _sign3009(buyerPk, buyer, seller, value, nonce), value - 1);
        assertEq(usdc.balanceOf(seller), SELLER_USDC + 1, "seller strictly net positive");
    }

    function test_settleWithPermit2_zeroFee_reverts() public {
        ProvianX402FeeSettler.PermitTransferFrom memory p = _permit(address(pvt), 1e18, 2);
        ProvianX402FeeSettler.Witness memory w = ProvianX402FeeSettler.Witness({to: seller, validAfter: 0});
        bytes memory sig = _signPermit(buyerPk, p, w);
        vm.prank(operator);
        vm.expectRevert(ProvianX402FeeSettler.FeeOutOfRange.selector);
        settler.settleWithPermit2(p, buyer, w, sig, 0);
    }

    function test_settleWithPermit2_feeAboveMax_reverts() public {
        ProvianX402FeeSettler.PermitTransferFrom memory p = _permit(address(pvt), 1e18, 3);
        ProvianX402FeeSettler.Witness memory w = ProvianX402FeeSettler.Witness({to: seller, validAfter: 0});
        bytes memory sig = _signPermit(buyerPk, p, w);
        vm.prank(operator);
        vm.expectRevert(ProvianX402FeeSettler.FeeOutOfRange.selector);
        settler.settleWithPermit2(p, buyer, w, sig, MAX_FEE + 1);
    }

    function test_settleWithPermit2_usdcFeeEqualsAmount_reverts() public {
        ProvianX402FeeSettler.PermitTransferFrom memory p = _permit(address(usdc), 10_000, 4);
        ProvianX402FeeSettler.Witness memory w = ProvianX402FeeSettler.Witness({to: seller, validAfter: 0});
        bytes memory sig = _signPermit(buyerPk, p, w);
        vm.prank(operator);
        vm.expectRevert(ProvianX402FeeSettler.FeeNotBelowValue.selector);
        settler.settleWithPermit2(p, buyer, w, sig, 10_000);
    }

    function test_settleWithPermit2_usdcFeeAboveAmount_reverts() public {
        ProvianX402FeeSettler.PermitTransferFrom memory p = _permit(address(usdc), 10_000, 5);
        ProvianX402FeeSettler.Witness memory w = ProvianX402FeeSettler.Witness({to: seller, validAfter: 0});
        bytes memory sig = _signPermit(buyerPk, p, w);
        vm.prank(operator);
        vm.expectRevert(ProvianX402FeeSettler.FeeNotBelowValue.selector);
        settler.settleWithPermit2(p, buyer, w, sig, 10_001);
    }

    // ------------------------------------------------------------------ REDs: token allowlist

    /// A genuine buyer signature paying the seller a real transfer of a token that is
    /// neither PVT nor USDC (e.g. one the attacker deployed) is refused before the proxy is
    /// called: no payment, no fee.
    function test_settleWithPermit2_unknownToken_revertsTokenNotAccepted() public {
        X402MockERC20 junk = new X402MockERC20("Worthless", 18);
        junk.mint(buyer, 1_000e18);
        vm.prank(buyer);
        junk.approve(address(proxy), type(uint256).max);
        ProvianX402FeeSettler.PermitTransferFrom memory p = _permit(address(junk), 1e18, 20);
        ProvianX402FeeSettler.Witness memory w = ProvianX402FeeSettler.Witness({to: seller, validAfter: 0});
        bytes memory sig = _signPermit(buyerPk, p, w);

        vm.prank(operator);
        vm.expectRevert(ProvianX402FeeSettler.TokenNotAccepted.selector);
        settler.settleWithPermit2(p, buyer, w, sig, 1_000);
        assertEq(usdc.balanceOf(feeRecipient), 0, "no fee moved");
        assertEq(usdc.balanceOf(seller), SELLER_USDC, "seller untouched");
        assertEq(junk.balanceOf(seller), 0, "no junk payment landed");
        assertFalse(proxy.nonceUsed(buyer, 20), "proxy never reached");

        // Control: the permit itself is genuine -- the proxy delivers it when called
        // directly, so the refusal above is the settler's allowlist, not a bad signature.
        proxy.settle(p, buyer, w, sig);
        assertEq(junk.balanceOf(seller), 1e18);
    }

    function test_settleWithPermit2_zeroAddressToken_revertsTokenNotAccepted() public {
        ProvianX402FeeSettler.PermitTransferFrom memory p = _permit(address(0), 1e18, 21);
        ProvianX402FeeSettler.Witness memory w = ProvianX402FeeSettler.Witness({to: seller, validAfter: 0});
        vm.prank(operator);
        vm.expectRevert(ProvianX402FeeSettler.TokenNotAccepted.selector);
        settler.settleWithPermit2(p, buyer, w, "", 1_000);
        assertEq(usdc.balanceOf(feeRecipient), 0);
    }

    /// Fuzz: any token other than PVT/USDC is refused and moves no fee.
    function testFuzz_settleWithPermit2_onlyPvtOrUsdc(address token, uint256 amount) public {
        vm.assume(token != address(pvt) && token != address(usdc));
        ProvianX402FeeSettler.PermitTransferFrom memory p = _permit(token, amount, 22);
        ProvianX402FeeSettler.Witness memory w = ProvianX402FeeSettler.Witness({to: seller, validAfter: 0});
        vm.prank(operator);
        vm.expectRevert(ProvianX402FeeSettler.TokenNotAccepted.selector);
        settler.settleWithPermit2(p, buyer, w, "", 1_000);
        assertEq(usdc.balanceOf(feeRecipient), 0);
    }

    // ------------------------------------------------------------------ REDs: authorization

    function test_settleWithAuthorization_invalidSignature_revertsNoFee() public {
        bytes32 nonce = keccak256("bad");
        bytes memory sig = _sign3009(0xBAD, buyer, seller, 1e6, nonce); // not the buyer's key
        vm.prank(operator);
        vm.expectRevert(bytes("FiatTokenV2: invalid signature"));
        settler.settleWithAuthorization(buyer, seller, 1e6, 0, block.timestamp + 600, nonce, sig, 1_000);
        assertEq(usdc.balanceOf(feeRecipient), 0, "no fee moved");
        assertEq(usdc.balanceOf(seller), SELLER_USDC);
    }

    function test_settleWithAuthorization_emptySignature_revertsNoFee() public {
        vm.prank(operator);
        vm.expectRevert(bytes("FiatTokenV2: invalid signature"));
        settler.settleWithAuthorization(buyer, seller, 1e6, 0, block.timestamp + 600, keccak256("e"), "", 1_000);
        assertEq(usdc.balanceOf(feeRecipient), 0, "no fee moved");
    }

    /// The buyer signed a payment to `seller`; the operator cannot redirect it to seller2
    /// (the authorization binds `to`), so seller2 cannot be charged a fee off it.
    function test_settleWithAuthorization_signatureForOtherSeller_revertsNoFee() public {
        bytes32 nonce = keccak256("redirect");
        bytes memory sig = _sign3009(buyerPk, buyer, seller, 1e6, nonce);
        vm.prank(operator);
        vm.expectRevert(bytes("FiatTokenV2: invalid signature"));
        settler.settleWithAuthorization(buyer, seller2, 1e6, 0, block.timestamp + 600, nonce, sig, 1_000);
        assertEq(usdc.balanceOf(feeRecipient), 0);
        assertEq(usdc.balanceOf(seller2), SELLER_USDC);
    }

    function test_settleWithAuthorization_replay_revertsNoSecondFee() public {
        bytes32 nonce = keccak256("once");
        bytes memory sig = _sign3009(buyerPk, buyer, seller, 1e6, nonce);
        _settle3009(seller, 1e6, nonce, sig, 1_000);
        assertEq(usdc.balanceOf(feeRecipient), 1_000);

        vm.prank(operator);
        vm.expectRevert(bytes("FiatTokenV2: authorization is used or canceled"));
        settler.settleWithAuthorization(buyer, seller, 1e6, 0, block.timestamp + 600, nonce, sig, 1_000);
        assertEq(usdc.balanceOf(feeRecipient), 1_000, "no second fee");
        assertEq(usdc.balanceOf(seller), SELLER_USDC + 1e6 - 1_000);
    }

    /// buyer == seller: the authorization is genuine but the seller's balance does not rise,
    /// so no fee may be pulled.
    function test_settleWithAuthorization_selfPayment_paymentNotReceived() public {
        vm.prank(buyer);
        usdc.approve(address(settler), type(uint256).max);
        bytes32 nonce = keccak256("self");
        bytes memory sig = _sign3009(buyerPk, buyer, buyer, 1e6, nonce);
        vm.prank(operator);
        vm.expectRevert(ProvianX402FeeSettler.PaymentNotReceived.selector);
        settler.settleWithAuthorization(buyer, buyer, 1e6, 0, block.timestamp + 600, nonce, sig, 1_000);
        assertEq(usdc.balanceOf(feeRecipient), 0);
    }

    function test_settleWithAuthorization_sellerWithoutAllowance_atomicRevert() public {
        address bare = makeAddr("bareSeller"); // never approved the settler
        bytes32 nonce = keccak256("noallow");
        bytes memory sig = _sign3009(buyerPk, buyer, bare, 1e6, nonce);
        vm.prank(operator);
        vm.expectRevert(bytes("ERC20: transfer amount exceeds allowance"));
        settler.settleWithAuthorization(buyer, bare, 1e6, 0, block.timestamp + 600, nonce, sig, 1_000);
        assertEq(usdc.balanceOf(bare), 0, "buyer payment did not land");
        assertEq(usdc.balanceOf(buyer), BUYER_USDC, "buyer not debited");
        assertFalse(usdc.authorizationState(buyer, nonce), "authorization not consumed");
        assertEq(usdc.balanceOf(feeRecipient), 0);
    }

    function test_settleWithPermit2_sellerWithoutAllowance_atomicRevert() public {
        address bare = makeAddr("bareSeller");
        usdc.mint(bare, SELLER_USDC);
        ProvianX402FeeSettler.PermitTransferFrom memory p = _permit(address(pvt), 1e18, 9);
        ProvianX402FeeSettler.Witness memory w = ProvianX402FeeSettler.Witness({to: bare, validAfter: 0});
        bytes memory sig = _signPermit(buyerPk, p, w);
        vm.prank(operator);
        vm.expectRevert(bytes("ERC20: transfer amount exceeds allowance"));
        settler.settleWithPermit2(p, buyer, w, sig, 1_000);
        assertEq(pvt.balanceOf(bare), 0, "PVT payment did not land");
        assertFalse(proxy.nonceUsed(buyer, 9));
    }

    function test_settleWithPermit2_invalidSignature_revertsNoFee() public {
        ProvianX402FeeSettler.PermitTransferFrom memory p = _permit(address(pvt), 1e18, 10);
        ProvianX402FeeSettler.Witness memory w = ProvianX402FeeSettler.Witness({to: seller, validAfter: 0});
        bytes memory sig = _signPermit(0xBAD, p, w);
        vm.prank(operator);
        vm.expectRevert(bytes("InvalidSigner"));
        settler.settleWithPermit2(p, buyer, w, sig, 1_000);
        assertEq(usdc.balanceOf(feeRecipient), 0);
        assertEq(usdc.balanceOf(seller), SELLER_USDC);
    }

    function test_settleWithPermit2_replay_revertsNoSecondFee() public {
        ProvianX402FeeSettler.PermitTransferFrom memory p = _permit(address(pvt), 1e18, 11);
        ProvianX402FeeSettler.Witness memory w = ProvianX402FeeSettler.Witness({to: seller, validAfter: 0});
        bytes memory sig = _signPermit(buyerPk, p, w);
        vm.prank(operator);
        settler.settleWithPermit2(p, buyer, w, sig, 1_000);
        vm.prank(operator);
        vm.expectRevert(bytes("InvalidNonce"));
        settler.settleWithPermit2(p, buyer, w, sig, 1_000);
        assertEq(usdc.balanceOf(feeRecipient), 1_000, "no second fee");
    }

    function test_settleWithPermit2_nonDeliveringProxy_paymentNotReceived() public {
        X402NonDeliveringProxy bad = new X402NonDeliveringProxy();
        ProvianX402FeeSettler s2 = new ProvianX402FeeSettler(address(usdc), operator, feeRecipient, address(bad), address(pvt));
        vm.prank(seller);
        usdc.approve(address(s2), type(uint256).max);
        ProvianX402FeeSettler.PermitTransferFrom memory p = _permit(address(pvt), 1e18, 12);
        ProvianX402FeeSettler.Witness memory w = ProvianX402FeeSettler.Witness({to: seller, validAfter: 0});
        vm.prank(operator);
        vm.expectRevert(ProvianX402FeeSettler.PaymentNotReceived.selector);
        s2.settleWithPermit2(p, buyer, w, "", 1_000);
        assertEq(usdc.balanceOf(feeRecipient), 0, "no fee");
        assertEq(usdc.balanceOf(seller), SELLER_USDC);
    }

    /// Delivering LESS than the permitted amount is also refused (the delta must cover it).
    function test_settleWithPermit2_shortDelivery_paymentNotReceived() public {
        X402ShortProxy shortP = new X402ShortProxy();
        ProvianX402FeeSettler s2 = new ProvianX402FeeSettler(address(usdc), operator, feeRecipient, address(shortP), address(pvt));
        vm.prank(seller);
        usdc.approve(address(s2), type(uint256).max);
        vm.prank(buyer);
        pvt.approve(address(shortP), type(uint256).max);
        ProvianX402FeeSettler.PermitTransferFrom memory p = _permit(address(pvt), 1e18, 13);
        ProvianX402FeeSettler.Witness memory w = ProvianX402FeeSettler.Witness({to: seller, validAfter: 0});
        vm.prank(operator);
        vm.expectRevert(ProvianX402FeeSettler.PaymentNotReceived.selector);
        s2.settleWithPermit2(p, buyer, w, "", 1_000);
        assertEq(usdc.balanceOf(feeRecipient), 0);
    }

    // ------------------------------------------------------------------ fuzz

    /// For any 0 < fee <= MAX_FEE, fee < value: balances conserve exactly.
    function testFuzz_settleWithAuthorization_conserves(uint256 value, uint256 fee, bytes32 nonce) public {
        value = bound(value, 2, BUYER_USDC);
        fee = bound(fee, 1, value - 1 < MAX_FEE ? value - 1 : MAX_FEE);
        uint256 supplyBefore =
            usdc.balanceOf(buyer) + usdc.balanceOf(seller) + usdc.balanceOf(feeRecipient) + usdc.balanceOf(address(settler));

        _settle3009(seller, value, nonce, _sign3009(buyerPk, buyer, seller, value, nonce), fee);

        assertEq(usdc.balanceOf(buyer), BUYER_USDC - value);
        assertEq(usdc.balanceOf(seller), SELLER_USDC + value - fee);
        assertGt(usdc.balanceOf(seller), SELLER_USDC, "seller strictly net positive");
        assertEq(usdc.balanceOf(feeRecipient), fee);
        assertEq(usdc.balanceOf(address(settler)), 0);
        assertEq(
            usdc.balanceOf(buyer) + usdc.balanceOf(seller) + usdc.balanceOf(feeRecipient)
                + usdc.balanceOf(address(settler)),
            supplyBefore,
            "exact conservation"
        );
    }

    /// Arbitrary operator inputs (any value, any fee, any seller, a valid or forged
    /// signature, a signature bound to the right or a different recipient) never increase
    /// any balance except seller(+value) and feeRecipient(+fee), and never take the seller
    /// below its starting balance. Reverting calls change nothing.
    function testFuzz_settleWithAuthorization_feeOnlyToRecipient(
        uint256 value,
        uint256 fee,
        uint8 sellerPick,
        uint8 sigPick,
        bytes32 nonce
    ) public {
        value = bound(value, 0, BUYER_USDC + 1);
        fee = bound(fee, 0, MAX_FEE + 2);
        address[4] memory candidates = [seller, seller2, makeAddr("bareSeller"), stranger];
        address to = candidates[sellerPick % 4];

        bytes memory sig;
        uint256 mode = sigPick % 3;
        if (mode == 0) sig = _sign3009(buyerPk, buyer, to, value, nonce); // genuine
        else if (mode == 1) sig = _sign3009(0xBAD, buyer, to, value, nonce); // forged
        else sig = _sign3009(buyerPk, buyer, candidates[(uint256(sellerPick) + 1) % 4], value, nonce); // other recipient

        address[8] memory watched =
            [buyer, seller, seller2, candidates[2], stranger, operator, feeRecipient, address(settler)];
        uint256[8] memory before;
        for (uint256 i; i < 8; ++i) {
            before[i] = usdc.balanceOf(watched[i]);
        }

        vm.prank(operator);
        (bool ok,) = address(settler).call(
            abi.encodeCall(
                settler.settleWithAuthorization, (buyer, to, value, 0, block.timestamp + 600, nonce, sig, fee)
            )
        );

        for (uint256 i; i < 8; ++i) {
            address a = watched[i];
            uint256 nowBal = usdc.balanceOf(a);
            if (!ok) {
                assertEq(nowBal, before[i], "reverted call moved a balance");
            } else if (a == to) {
                assertEq(nowBal, before[i] + value - fee, "seller delta");
                assertGt(nowBal, before[i], "seller net positive");
            } else if (a == feeRecipient) {
                assertEq(nowBal, before[i] + fee, "fee delta");
            } else if (a == buyer) {
                assertEq(nowBal, before[i] - value, "buyer delta");
            } else {
                assertEq(nowBal, before[i], "bystander balance moved");
            }
            if (a == to) assertGe(nowBal, before[i], "seller below start");
        }
        if (ok) {
            assertEq(mode, 0, "only a genuine authorization can succeed");
            assertTrue(fee > 0 && fee <= MAX_FEE && fee < value, "fee bounds held");
        }
    }

    /// Same property on the Permit2 path: the USDC fee only ever lands at feeRecipient and
    /// only alongside a genuine payment of the permitted PVT to that same seller.
    function testFuzz_settleWithPermit2_feeOnlyToRecipient(
        uint256 amount,
        uint256 fee,
        uint8 sellerPick,
        uint8 sigPick,
        uint256 nonce
    ) public {
        amount = bound(amount, 1, 1_000_000e18);
        fee = bound(fee, 0, MAX_FEE + 2);
        address[4] memory candidates = [seller, seller2, makeAddr("bareSeller"), stranger];
        address to = candidates[sellerPick % 4];
        ProvianX402FeeSettler.PermitTransferFrom memory p = _permit(address(pvt), amount, nonce);
        ProvianX402FeeSettler.Witness memory w = ProvianX402FeeSettler.Witness({to: to, validAfter: 0});
        bytes memory sig;
        uint256 mode = sigPick % 3;
        if (mode == 0) {
            sig = _signPermit(buyerPk, p, w);
        } else if (mode == 1) {
            sig = _signPermit(0xBAD, p, w);
        } else {
            sig = _signPermit(
                buyerPk, p, ProvianX402FeeSettler.Witness({to: candidates[(uint256(sellerPick) + 1) % 4], validAfter: 0})
            );
        }

        address[8] memory watched =
            [buyer, seller, seller2, candidates[2], stranger, operator, feeRecipient, address(settler)];
        uint256[8] memory usdcBefore;
        uint256[8] memory pvtBefore;
        for (uint256 i; i < 8; ++i) {
            usdcBefore[i] = usdc.balanceOf(watched[i]);
            pvtBefore[i] = pvt.balanceOf(watched[i]);
        }

        vm.prank(operator);
        (bool ok,) = address(settler).call(abi.encodeCall(settler.settleWithPermit2, (p, buyer, w, sig, fee)));

        for (uint256 i; i < 8; ++i) {
            address a = watched[i];
            if (!ok) {
                assertEq(usdc.balanceOf(a), usdcBefore[i]);
                assertEq(pvt.balanceOf(a), pvtBefore[i]);
            } else if (a == to) {
                assertEq(pvt.balanceOf(a), pvtBefore[i] + amount, "seller PVT delta");
                assertEq(usdc.balanceOf(a), usdcBefore[i] - fee, "seller USDC fee");
            } else if (a == feeRecipient) {
                assertEq(usdc.balanceOf(a), usdcBefore[i] + fee);
                assertEq(pvt.balanceOf(a), pvtBefore[i]);
            } else if (a == buyer) {
                assertEq(pvt.balanceOf(a), pvtBefore[i] - amount);
                assertEq(usdc.balanceOf(a), usdcBefore[i]);
            } else {
                assertEq(usdc.balanceOf(a), usdcBefore[i], "bystander USDC moved");
                assertEq(pvt.balanceOf(a), pvtBefore[i], "bystander PVT moved");
            }
        }
        if (ok) {
            assertEq(mode, 0, "only a genuine authorization can succeed");
            assertTrue(fee > 0 && fee <= MAX_FEE, "fee bounds held");
        }
    }
}

/// @dev A proxy that delivers one wei less than permitted.
contract X402ShortProxy {
    function settle(
        ProvianX402FeeSettler.PermitTransferFrom calldata permit,
        address owner,
        ProvianX402FeeSettler.Witness calldata witness,
        bytes calldata
    ) external {
        X402MockERC20(permit.permitted.token).transferFrom(owner, witness.to, permit.permitted.amount - 1);
    }
}
