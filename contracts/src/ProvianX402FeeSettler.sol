// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @dev Base USDC (FiatToken v2.2) surface the settler uses. The EIP-3009 call is the
///      BYTES-signature overload (selector 0xcf092995), which accepts a 65-byte EOA
///      signature or an ERC-1271 contract-wallet signature.
interface IFiatTokenV22 {
    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes calldata signature
    ) external;

    function balanceOf(address account) external view returns (uint256);
}

interface IBalanceOf {
    function balanceOf(address account) external view returns (uint256);
}

/// @dev x402ExactPermit2Proxy (Base 0x402085c248EeA27D92E8b30b2C58ed07f9E20001).
///      `settle` (selector 0x13cd3b53) moves `permit.permitted.amount` of
///      `permit.permitted.token` from `owner` to `witness.to` through Permit2's
///      permitWitnessTransferFrom, with the proxy as the Permit2 spender. It does not
///      restrict its caller: authority is the owner's Permit2 witness signature alone.
interface IX402ExactPermit2Proxy {
    function settle(
        ProvianX402FeeSettler.PermitTransferFrom calldata permit,
        address owner,
        ProvianX402FeeSettler.Witness calldata witness,
        bytes calldata signature
    ) external;
}

/**
 * @title ProvianX402FeeSettler
 * @notice Settles a buyer's x402 payment AND collects Provian's settlement fee in the
 *         SAME transaction. The buyer pays the seller DIRECTLY (EIP-3009 on USDC, or the
 *         x402 Permit2 proxy for PVT, which has no EIP-3009); this contract never
 *         holds the payment. The fee is USDC, paid by the SELLER out of the seller's own
 *         allowance to this contract, and lands only at the immutable `feeRecipient`.
 *
 * @dev No owner, no setters, no proxy, no admin, no storage: immutables only. The
 *      contract holds no funds between calls (every transfer it causes is
 *      buyer -> seller or seller -> feeRecipient; it is never a party).
 *
 *      SECURITY PROPERTY. A leaked `operator` key cannot pull a fee without a genuine
 *      buyer authorization that pays that SAME seller in the same transaction (the
 *      seller's balance delta is measured, not trusted), and the fee always goes to the
 *      immutable `feeRecipient` (Provian's own wallet), never to the caller. On the USDC
 *      path the seller is always net positive: 0 < fee < value, and the seller is
 *      credited `value` before the fee is pulled.
 *
 *      TOKEN ALLOWLIST. The Permit2 path accepts only the immutable `pvt` or `usdc` as the
 *      payment token (else TokenNotAccepted), so a payment can never be made in a
 *      worthless token an attacker deployed.
 *
 *      RESIDUAL (documented, not fixed). On the Permit2 path with PVT the fee (USDC) is not
 *      bounded by the payment's value. A leaked operator key together with a buyer key
 *      the attacker controls must still pay the seller REAL PVT (or real USDC, where
 *      fee < amount holds) to pull a fee; it can grief a seller by paying dust PVT and
 *      pulling up to MAX_FEE USDC per call into Provian's wallet. That costs the attacker
 *      real tokens on every call, gains it nothing (the fee lands at `feeRecipient`), and
 *      is bounded by the seller's USDC allowance to this settler, so sellers should
 *      approve a small fee allowance and top it up.
 *
 *      FRONT-RUN (fee-only). EIP-3009 `transferWithAuthorization` and the proxy's
 *      `settle` are permissionless, so anyone holding the buyer's signature can submit
 *      it directly first; the seller is then paid and this contract's call reverts (the
 *      nonce is spent), costing Provian its fee for that payment and nothing else.
 */
contract ProvianX402FeeSettler {
    /// @dev Permit2 ISignatureTransfer layout.
    struct TokenPermissions {
        address token;
        uint256 amount;
    }

    /// @dev Permit2 ISignatureTransfer.PermitTransferFrom layout.
    struct PermitTransferFrom {
        TokenPermissions permitted;
        uint256 nonce;
        uint256 deadline;
    }

    /// @dev x402ExactPermit2Proxy.Witness layout.
    struct Witness {
        address to;
        uint256 validAfter;
    }

    /// @notice Base USDC (0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913). The fee token.
    address public immutable usdc;
    /// @notice The facilitator's Base gas EOA; the only caller of both settle paths.
    address public immutable operator;
    /// @notice Where every fee lands (the same gas EOA, so fee income can buy gas).
    address public immutable feeRecipient;
    /// @notice x402ExactPermit2Proxy (0x402085c248EeA27D92E8b30b2C58ed07f9E20001).
    address public immutable permit2Proxy;
    /// @notice Base PVT9 (0x8811441914381143b9408c5C32247367F86F173A). With `usdc`, the only
    ///         payment tokens the Permit2 path accepts.
    address public immutable pvt;
    /// @notice Fee ceiling: $0.05 in USDC atomic units (6 decimals).
    uint256 public constant MAX_FEE = 50_000;

    event FeeSettled(address indexed buyer, address indexed seller, address indexed token, uint256 value, uint256 fee);

    error NotOperator();
    error ZeroAddress();
    error FeeOutOfRange();
    error FeeNotBelowValue();
    error PaymentNotReceived();
    /// @dev The seller -> feeRecipient USDC pull returned false or non-bool data.
    error FeeTransferFailed();
    /// @dev The Permit2 payment token is neither `pvt` nor `usdc`.
    error TokenNotAccepted();

    constructor(address usdc_, address operator_, address feeRecipient_, address permit2Proxy_, address pvt_) {
        if (
            usdc_ == address(0) || operator_ == address(0) || feeRecipient_ == address(0)
                || permit2Proxy_ == address(0) || pvt_ == address(0)
        ) revert ZeroAddress();
        usdc = usdc_;
        operator = operator_;
        feeRecipient = feeRecipient_;
        permit2Proxy = permit2Proxy_;
        pvt = pvt_;
    }

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator();
        _;
    }

    /**
     * @notice USDC path (EIP-3009). The buyer's authorization pays the seller directly;
     *         the seller's balance must rise by at least `value`; then `fee` USDC is
     *         pulled from the seller to `feeRecipient`.
     * @dev Requires 0 < fee <= MAX_FEE and fee < value, so the seller nets value - fee > 0.
     */
    function settleWithAuthorization(
        address buyer,
        address seller,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes calldata signature,
        uint256 fee
    ) external onlyOperator {
        if (fee == 0 || fee > MAX_FEE) revert FeeOutOfRange();
        if (fee >= value) revert FeeNotBelowValue();

        uint256 before = IFiatTokenV22(usdc).balanceOf(seller);
        IFiatTokenV22(usdc).transferWithAuthorization(buyer, seller, value, validAfter, validBefore, nonce, signature);
        _requireReceived(usdc, seller, before, value);

        _pullFee(seller, fee);
        emit FeeSettled(buyer, seller, usdc, value, fee);
    }

    /**
     * @notice Permit2 path (PVT, which has no EIP-3009; USDC is also accepted). The x402 proxy moves the
     *         permitted amount from the buyer to `witness.to` (the seller); the seller's
     *         token balance must rise by at least that amount; then `fee` USDC is pulled
     *         from the seller to `feeRecipient`.
     * @dev Requires the permitted token to be `pvt` or `usdc` (else TokenNotAccepted) and
     *      0 < fee <= MAX_FEE; when the permitted token is USDC, also fee < amount.
     *      See the contract-level RESIDUAL for the PVT case.
     */
    function settleWithPermit2(
        PermitTransferFrom calldata permit,
        address buyer,
        Witness calldata witness,
        bytes calldata signature,
        uint256 fee
    ) external onlyOperator {
        if (fee == 0 || fee > MAX_FEE) revert FeeOutOfRange();
        address token = permit.permitted.token;
        if (token != pvt && token != usdc) revert TokenNotAccepted();
        uint256 amount = permit.permitted.amount;
        if (token == usdc && fee >= amount) revert FeeNotBelowValue();

        address seller = witness.to;
        uint256 before = IBalanceOf(token).balanceOf(seller);
        IX402ExactPermit2Proxy(permit2Proxy).settle(permit, buyer, witness, signature);
        _requireReceived(token, seller, before, amount);

        _pullFee(seller, fee);
        emit FeeSettled(buyer, seller, token, amount, fee);
    }

    function _requireReceived(address token, address seller, uint256 before, uint256 amount) private view {
        uint256 afterBal = IBalanceOf(token).balanceOf(seller);
        if (afterBal < before || afterBal - before < amount) revert PaymentNotReceived();
    }

    /// @dev Safe transferFrom: bubbles a revert, accepts no return data or a true bool,
    ///      refuses false. The destination is always the immutable feeRecipient.
    function _pullFee(address seller, uint256 fee) private {
        (bool ok, bytes memory ret) =
            usdc.call(abi.encodeWithSelector(0x23b872dd, seller, feeRecipient, fee)); // transferFrom
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 0x20), mload(ret))
            }
        }
        if (ret.length != 0 && (ret.length != 32 || abi.decode(ret, (uint256)) != 1)) revert FeeTransferFailed();
    }
}
