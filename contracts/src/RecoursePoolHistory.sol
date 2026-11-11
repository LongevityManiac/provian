// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {RecourseMonthlyAccounting} from "./RecourseMonthlyAccounting.sol";
import {RecourseReserveAccounting,IRecourseReserveToken} from "./RecourseReserveAccounting.sol";

/// @notice Complete, permissionlessly imported pool state at one committed
/// custody cutoff. No membership operation can race a partial state import.
abstract contract RecoursePoolHistory is RecourseMonthlyAccounting, RecourseReserveAccounting {
    mapping(address => bytes32) public ownerOf;
    mapping(bytes32 => address) public primaryAddress;
    mapping(bytes32 => uint256) public recoveryNonce;
    mapping(bytes32 => uint256) public outcomeRevision;
    struct MembershipPeriod { uint256 startBlock; uint256 endBlock; uint256 startMonth; }
    mapping(bytes32 => mapping(uint256 => MembershipPeriod)) public membershipPeriods;
    mapping(bytes32 => bool) public determined;
    mapping(bytes32 => mapping(bytes32 => bool)) public occurrenceDetermined;
    mapping(bytes32 => bool) public requiresSnapshotRecovery;
    event AddressBound(bytes32 indexed identity,address indexed account);
    struct PoolSnapshot { address predecessor; uint256 blockNumber; bytes32 root; uint256 entries; bool afterBreak; }
    PoolSnapshot public poolSnapshot;
    uint256 public importedPoolEntries;
    bool public poolHistoryReady;
    mapping(bytes32 => bool) private importedSlots;
    uint256 private importedAllocations;
    uint256 private unmatchedPrimaries;
    bool private importedGlobals;
    error InvalidPoolHistory();
    event PoolStateImported(uint8 indexed kind,bytes32 indexed slot,bytes32 leaf,bytes data);
    event PoolHistoryActivated(bytes32 indexed root,uint256 entries);
    constructor(IRecourseReserveToken token_,PoolSnapshot memory snapshot) RecourseReserveAccounting(token_) {
        if (snapshot.entries==0) {
            if(snapshot.predecessor!=address(0)||snapshot.blockNumber!=0||snapshot.root!=bytes32(0)||snapshot.afterBreak) revert InvalidPoolHistory();
            poolHistoryReady=true;
        } else if(snapshot.predecessor==address(0)||snapshot.root==bytes32(0)||snapshot.blockNumber>=block.number) revert InvalidPoolHistory();
        poolSnapshot=snapshot;
    }
    modifier historyReady() { if(!poolHistoryReady) revert InvalidPoolHistory(); _; }
    function _slot(uint8 kind,bytes memory key) private pure returns(bytes32) { return sha256(abi.encode(kind,key)); }
    /// kinds: globals, ordered rules, owner, invoice, membership period,
    /// allocation, reserved kind, address binding, determination replay fence.
    function importPoolState(uint8 kind,bytes calldata data,bytes32[] calldata proof) external {
        if(poolHistoryReady||importedPoolEntries>=poolSnapshot.entries||proof.length>256) revert InvalidPoolHistory();
        bytes32 leaf=sha256(abi.encode("Provian pool succession",poolSnapshot.predecessor,poolSnapshot.blockNumber,kind,sha256(data)));
        bytes32 digest=leaf;
        for(uint256 i;i<proof.length;++i){bytes32 sibling=proof[i];digest=digest<sibling?sha256(abi.encodePacked(digest,sibling)):sha256(abi.encodePacked(sibling,digest));}
        if(digest!=poolSnapshot.root) revert InvalidPoolHistory();
        bytes32 slot;
        if(kind==0){
            if(importedPoolEntries!=0) revert InvalidPoolHistory();
            (allocatedRestorations,accountedBacking)=abi.decode(data,(uint256,uint256));
            importedGlobals=true;slot=_slot(kind,"");
        } else {
            if(!importedGlobals) revert InvalidPoolHistory();
            slot=_importPoolRecord(kind,data);
        }
        if(importedSlots[slot]) revert InvalidPoolHistory();
        importedSlots[slot]=true;++importedPoolEntries;
        emit PoolStateImported(kind,slot,leaf,data);
    }
    function _requireImportedOwner(bytes32 identity) private view {
        if (!importedSlots[_slot(2, abi.encode(identity))]) revert InvalidPoolHistory();
    }
    function _importPoolRecord(uint8 kind,bytes calldata data) private returns(bytes32 slot){
        if(kind==1){
            (uint256 index,MonthlyRule memory rule)=abi.decode(data,(uint256,MonthlyRule));
            if(index!=monthlyRules.length||rule.signedRuleHash==bytes32(0)||rule.earningsBps>10000
                ||(index==0?rule.firstMonth!=0:rule.firstMonth<=monthlyRules[index-1].firstMonth)) revert InvalidPoolHistory();
            monthlyRules.push(rule);slot=_slot(kind,abi.encode(index));
        } else if(kind==2){
            (bytes32 id,Enrollment memory e,address primary,uint256 nonce,uint256 revision,bool recoveryRequired)=abi.decode(data,(bytes32,Enrollment,address,uint256,uint256,bool));
            if(id==bytes32(0)||(e.generation!=0&&e.startMonth>e.lastAssessedMonth)) revert InvalidPoolHistory();
            enrollment[id]=e;outcomeRevision[id]=revision;
            if(poolSnapshot.afterBreak||recoveryRequired){requiresSnapshotRecovery[id]=true;primaryAddress[id]=address(0);recoveryNonce[id]=0;}
            else {primaryAddress[id]=primary;recoveryNonce[id]=nonce;if(primary!=address(0))++unmatchedPrimaries;}
            slot=_slot(kind,abi.encode(id));
        } else if(kind==3){
            (bytes32 id,uint256 generation,uint256 month,MonthlyObligation memory o)=abi.decode(data,(bytes32,uint256,uint256,MonthlyObligation));
            if(id==bytes32(0)||generation==0||!o.initialized||o.burnPaid>o.burnDue||o.reservePaid>o.reserveDue
                ||o.earningsBps>10000||o.earningsRemainder>=10000) revert InvalidPoolHistory();
            _requireImportedOwner(id);
            obligations[id][generation][month]=o;slot=_slot(kind,abi.encode(id,generation,month));
        } else if(kind==4){
            (bytes32 id,uint256 generation,MembershipPeriod memory period)=abi.decode(data,(bytes32,uint256,MembershipPeriod));
            if(id==bytes32(0)||generation==0||period.startBlock==0||period.startBlock>poolSnapshot.blockNumber
                ||(period.endBlock!=0&&(period.endBlock<period.startBlock||period.endBlock>poolSnapshot.blockNumber))) revert InvalidPoolHistory();
            _requireImportedOwner(id);
            membershipPeriods[id][generation]=period;slot=_slot(kind,abi.encode(id,generation));
        } else if(kind==5){
            (bytes32 request,RestorationAllocation memory allocation)=abi.decode(data,(bytes32,RestorationAllocation));
            if(request==bytes32(0)||allocation.identity==bytes32(0)) revert InvalidPoolHistory();
            _requireImportedOwner(allocation.identity);
            restorationAllocations[request]=allocation;if(!allocation.withdrawn)importedAllocations+=allocation.amount;
            slot=_slot(kind,abi.encode(request));
        } else if(kind==7){
            (address account,bytes32 id)=abi.decode(data,(address,bytes32));
            if(account==address(0)||id==bytes32(0)||!importedSlots[_slot(2,abi.encode(id))]) revert InvalidPoolHistory();
            ownerOf[account]=id;
            if(!poolSnapshot.afterBreak&&primaryAddress[id]==account)--unmatchedPrimaries;
            slot=_slot(kind,abi.encode(account));emit AddressBound(id,account);
        } else if(kind==8){
            (bytes32 request,bytes32 id,bytes32 occurrence)=abi.decode(data,(bytes32,bytes32,bytes32));
            if(request==bytes32(0)||id==bytes32(0)||occurrence==bytes32(0)||determined[request]||occurrenceDetermined[id][occurrence]) revert InvalidPoolHistory();
            _requireImportedOwner(id);
            determined[request]=true;occurrenceDetermined[id][occurrence]=true;slot=_slot(kind,abi.encode(request));
        } else revert InvalidPoolHistory();
    }
    function monthlyRuleCount() external view returns (uint256) { return monthlyRules.length; }
    function monthlyRuleAt(uint256 index) external view returns (MonthlyRule memory) { return monthlyRules[index]; }
    function activatePoolHistory() external {
        if(poolHistoryReady||!importedGlobals||importedPoolEntries!=poolSnapshot.entries||monthlyRules.length==0
            ||importedAllocations!=allocatedRestorations||unmatchedPrimaries!=0
            ||reserveToken.balanceOf(address(this))<allocatedRestorations+accountedBacking) revert InvalidPoolHistory();
        poolHistoryReady=true;emit PoolHistoryActivated(poolSnapshot.root,poolSnapshot.entries);
    }
}
