// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @dev Slimmed ERC-20 + self-burn interface for the PVT token, as used by the
 *      Agent Bank fee-burn sinks (Escrow / Promise / Pool / Bond).
 *
 *      This is the exact PVT surface those sinks call: the standard ERC-20
 *      transfer / transferFrom (+ the approve / balanceOf ERC-20 completeness
 *      pair) plus `burn(uint256)` — a self-burn of msg.sender's own balance.
 *      Every sink burns PVT it already custodies in its own balance (pulled in
 *      via transferFrom, or held as locked collateral), so `burn(amount)` is the
 *      exact drop-in for the historical `protocolBurn(amount)` and needs no
 *      allowance / burnFrom.
 *
 *      It deliberately OMITS the dead IPVT surface that PVT9 does not implement:
 *      protocolBurn, slashReputation, voiceBurn, burnForProposal, setVoiceContract,
 *      and the supply-scaler views (currentSupplyScaler / effectiveMintRate /
 *      stakeRatioBps / tokenomicSnapshot). Sinks type `pvt` against this interface
 *      and never bind to a concrete PVT9 contract type.
 */
interface IPVTBurnable {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function burn(uint256 amount) external;
}
