// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Adapted from SHLOK333/Kyvanta, contracts/src/SlhDsaSha2128s.sol (MIT OR Apache-2.0).
// Attribution and license: contracts/licenses/Kyvanta.txt.
// FIPS 205 SLH-DSA-SHA2-128s verification, external interface, empty context.
// Owner intents are exactly 32 bytes; the external message domain is 0x0000.
library SlhDsaSha2128s {
    // ---------------------------------------------------------------------
    // Parameters (FIPS 205 Table 2)
    // ---------------------------------------------------------------------

    uint256 internal constant N = 16; // security parameter, bytes
    uint256 internal constant H = 63; // total hypertree height
    uint256 internal constant D = 7; // hypertree layers
    uint256 internal constant HP = 9; // height of one layer, H / D
    uint256 internal constant A = 12; // FORS tree height
    uint256 internal constant K = 14; // FORS trees
    uint256 internal constant W = 16; // Winternitz parameter
    uint256 internal constant LEN1 = 32; // 2n message digits
    uint256 internal constant LEN2 = 3; // checksum digits
    uint256 internal constant LEN = 35; // LEN1 + LEN2
    uint256 internal constant M = 30; // message digest bytes

    uint256 internal constant SIG_BYTES = 7856;
    uint256 internal constant PK_BYTES = 32;

    /// Bytes of the digest consumed by the FORS indices: ceil(K * A / 8).
    uint256 internal constant MD_BYTES = 21;
    /// ceil((H - H/D) / 8)
    uint256 internal constant TREE_IDX_BYTES = 7;
    /// ceil(H / (8 * D))
    uint256 internal constant LEAF_IDX_BYTES = 2;

    // ADRS type tags.
    uint32 internal constant ADRS_WOTS_HASH = 0;
    uint32 internal constant ADRS_WOTS_PK = 1;
    uint32 internal constant ADRS_TREE = 2;
    uint32 internal constant ADRS_FORS_TREE = 3;
    uint32 internal constant ADRS_FORS_ROOTS = 4;

    /// Offset of the compressed ADRS within the hash scratch buffer.
    /// Layout: PK.seed (16) || zero padding (48) || ADRS^c (22) || payload.
    uint256 private constant ADRS_OFF = 64;
    uint256 private constant DATA_OFF = 86;

    // ---------------------------------------------------------------------
    // Scratch buffer
    // ---------------------------------------------------------------------

    /// @dev A reusable hashing buffer.
    ///
    /// `ptr` points at a memory region laid out as
    /// `PK.seed || 0^48 || ADRS^c || payload`. The first 64 bytes are written
    /// once per verification and never touched again; only the address and
    /// payload change between calls. Reusing one allocation matters: a
    /// verification makes over 2,000 hash calls, and allocating a fresh buffer
    /// for each would dominate the gas.
    struct Buf {
        uint256 ptr;
    }

    /// @dev Allocates the scratch buffer and writes the constant prefix.
    ///      Sized for the largest payload, which is T_len over 35 blocks.
    function _initBuf(bytes memory pkSeed) private pure returns (Buf memory buf) {
        // 32 bytes of slack: _setPayload writes a full word, so storing the
        // last block would otherwise run past the allocation and clobber
        // whatever was allocated after it.
        uint256 size = DATA_OFF + LEN * N + 32;
        uint256 ptr;
        assembly {
            ptr := mload(0x40)
            mstore(0x40, and(add(add(ptr, size), 31), not(31)))
            // Zero the prefix region so the 48 padding bytes are clean.
            mstore(ptr, 0)
            mstore(add(ptr, 32), 0)
            mstore(add(ptr, 64), 0)
        }
        // PK.seed occupies the first 16 bytes; the next 48 stay zero, making
        // the prefix exactly one SHA-256 block.
        assembly {
            let seedWord := mload(add(pkSeed, 32))
            // Keep only the high 16 bytes of the loaded word.
            mstore(ptr, and(seedWord, 0xffffffffffffffffffffffffffffffff00000000000000000000000000000000))
        }
        buf.ptr = ptr;
    }

    /// @dev Writes a compressed ADRS into the buffer.
    ///
    /// The compressed form keeps the low byte of the layer, the low 8 bytes of
    /// the tree address, the low byte of the type, and the three trailing
    /// words: 22 bytes in total.
    function _setAdrs(
        Buf memory buf,
        uint8 layer,
        uint64 tree,
        uint32 adrsType,
        uint32 w1,
        uint32 w2,
        uint32 w3
    ) private pure {
        uint256 ptr = buf.ptr + ADRS_OFF;
        // Pack into a single 256-bit word, left-aligned, then store 22 bytes of
        // it. Building the word arithmetically is far cheaper than 22 byte
        // writes, and this runs on every hash call.
        // Byte 0 layer | bytes 1-8 tree | byte 9 type | bytes 10-21 the three
        // words: 22 bytes, occupying bits 80..256 of a single word. The two
        // single-byte fields are masked so a wide argument cannot bleed into
        // its neighbour.
        uint256 packed = ((uint256(layer) & 0xff) << 248) |
            (uint256(tree) << 184) |
            ((uint256(adrsType) & 0xff) << 176) |
            (uint256(w1) << 144) |
            (uint256(w2) << 112) |
            (uint256(w3) << 80);
        assembly {
            // The low 10 bytes of this word are the start of the payload, so
            // preserve them rather than clobbering a full word.
            let existing := mload(ptr)
            mstore(ptr, or(packed, and(existing, sub(shl(80, 1), 1))))
        }
    }

    /// @dev Calls the SHA-256 precompile over `len` bytes at the buffer start,
    ///      truncated to `N` bytes and returned left-aligned in a bytes16.
    function _thash(Buf memory buf, uint256 payloadLen) private view returns (bytes16 out) {
        uint256 ptr = buf.ptr;
        uint256 total = DATA_OFF + payloadLen;
        assembly {
            let ok := staticcall(gas(), 0x02, ptr, total, 0x00, 0x20)
            if iszero(ok) {
                revert(0, 0)
            }
            // Truncate to the high N bytes. Masking explicitly: a bytes16
            // written from assembly is not cleaned for us, and stale low bytes
            // would corrupt every comparison downstream.
            out := and(mload(0x00), shl(mul(8, sub(32, N)), not(0)))
        }
    }

    /// @dev Writes an N-byte value into the payload region at block `index`.
    function _setPayload(Buf memory buf, uint256 index, bytes16 value) private pure {
        uint256 ptr = buf.ptr + DATA_OFF + index * N;
        assembly {
            let existing := mload(ptr)
            // Replace the high 16 bytes, keep the low 16.
            mstore(ptr, or(value, and(existing, sub(shl(128, 1), 1))))
        }
    }

    // ---------------------------------------------------------------------
    // WOTS+
    // ---------------------------------------------------------------------

    /// @dev Advances a chain value `steps` times from position `start`.
    function _chain(
        Buf memory buf,
        bytes16 x,
        uint32 start,
        uint32 steps,
        uint8 layer,
        uint64 tree,
        uint32 keyPair,
        uint32 chainIdx
    ) private view returns (bytes16) {
        bytes16 tmp = x;
        for (uint32 j = start; j < start + steps; j++) {
            _setAdrs(buf, layer, tree, ADRS_WOTS_HASH, keyPair, chainIdx, j);
            _setPayload(buf, 0, tmp);
            tmp = _thash(buf, N);
        }
        return tmp;
    }

    /// @dev Expands an N-byte message into LEN base-16 digits: LEN1 message
    ///      nibbles followed by LEN2 checksum nibbles.
    function _wotsDigits(bytes16 msgBlock) private pure returns (uint8[LEN] memory digits) {
        uint256 csum = 0;
        for (uint256 i = 0; i < LEN1; i++) {
            uint8 b = uint8(msgBlock[i / 2]);
            uint8 d = (i % 2 == 0) ? (b >> 4) : (b & 0x0f);
            digits[i] = d;
            csum += (W - 1 - d);
        }
        // LEN2 * lg_w = 12 bits, so left-align within two bytes.
        csum <<= 4;
        digits[LEN1] = uint8((csum >> 12) & 0x0f);
        digits[LEN1 + 1] = uint8((csum >> 8) & 0x0f);
        digits[LEN1 + 2] = uint8((csum >> 4) & 0x0f);
    }

    /// @dev Recovers the WOTS+ public key implied by a signature.
    function _wotsPkFromSig(
        Buf memory buf,
        bytes calldata sig,
        uint256 sigOff,
        bytes16 msgBlock,
        uint8 layer,
        uint64 tree,
        uint32 keyPair
    ) private view returns (bytes16) {
        uint8[LEN] memory digits = _wotsDigits(msgBlock);

        // Chain ends accumulate in a separate array, not directly in the payload
        // region. `_chain` uses payload block 0 as its own scratch on every
        // step, so writing an end there would be destroyed by the next chain.
        bytes16[LEN] memory ends;
        for (uint256 i = 0; i < LEN; i++) {
            ends[i] = _chain(
                buf,
                bytes16(_loadN(sig, sigOff + i * N)),
                digits[i],
                uint32(W - 1 - digits[i]),
                layer,
                tree,
                keyPair,
                uint32(i)
            );
        }

        // Only once every chain is finished is it safe to lay them out for
        // T_len.
        for (uint256 i = 0; i < LEN; i++) {
            _setPayload(buf, i, ends[i]);
        }
        _setAdrs(buf, layer, tree, ADRS_WOTS_PK, keyPair, 0, 0);
        return _thash(buf, LEN * N);
    }

    // ---------------------------------------------------------------------
    // FORS
    // ---------------------------------------------------------------------

    /// @dev Extracts K indices of A bits each from the message digest.
    function _forsIndices(bytes memory md) private pure returns (uint32[K] memory idx) {
        uint256 acc = 0;
        uint256 bits = 0;
        uint256 pos = 0;
        for (uint256 i = 0; i < K; i++) {
            while (bits < A) {
                acc = (acc << 8) | uint8(md[pos]);
                pos++;
                bits += 8;
            }
            bits -= A;
            idx[i] = uint32((acc >> bits) & ((1 << A) - 1));
            acc &= (1 << bits) - 1;
        }
    }

    /// @dev Recovers the FORS public key implied by a signature.
    function _forsPkFromSig(
        Buf memory buf,
        bytes calldata sig,
        uint256 sigOff,
        bytes memory md,
        uint64 tree,
        uint32 keyPair
    ) private view returns (bytes16) {
        uint32[K] memory indices = _forsIndices(md);
        bytes16[K] memory roots;

        uint256 stride = (A + 1) * N;
        for (uint256 i = 0; i < K; i++) {
            uint256 base = sigOff + i * stride;

            // Hash the revealed leaf secret into its leaf node.
            uint32 treeIdx = uint32((i << A) + indices[i]);
            _setAdrs(buf, 0, tree, ADRS_FORS_TREE, keyPair, 0, treeIdx);
            _setPayload(buf, 0, bytes16(_loadN(sig, base)));
            bytes16 node = _thash(buf, N);

            // Walk the authentication path to the tree root.
            for (uint256 j = 0; j < A; j++) {
                bytes16 auth = bytes16(_loadN(sig, base + N + j * N));
                if (((indices[i] >> j) & 1) == 0) {
                    treeIdx = treeIdx / 2;
                    _setAdrs(buf, 0, tree, ADRS_FORS_TREE, keyPair, uint32(j + 1), treeIdx);
                    _setPayload(buf, 0, node);
                    _setPayload(buf, 1, auth);
                } else {
                    treeIdx = (treeIdx - 1) / 2;
                    _setAdrs(buf, 0, tree, ADRS_FORS_TREE, keyPair, uint32(j + 1), treeIdx);
                    _setPayload(buf, 0, auth);
                    _setPayload(buf, 1, node);
                }
                node = _thash(buf, 2 * N);
            }
            roots[i] = node;
        }

        for (uint256 i = 0; i < K; i++) {
            _setPayload(buf, i, roots[i]);
        }
        _setAdrs(buf, 0, tree, ADRS_FORS_ROOTS, keyPair, 0, 0);
        return _thash(buf, K * N);
    }

    // ---------------------------------------------------------------------
    // Hypertree
    // ---------------------------------------------------------------------

    /// @dev Recomputes the hypertree root implied by a signature.
    function _htRootFromSig(
        Buf memory buf,
        bytes calldata sig,
        uint256 sigOff,
        bytes16 leafMsg,
        uint64 idxTree,
        uint32 idxLeaf
    ) private view returns (bytes16) {
        uint256 stride = (LEN + HP) * N;
        bytes16 node = leafMsg;
        uint64 tree = idxTree;
        uint32 leaf = idxLeaf;

        for (uint256 layer = 0; layer < D; layer++) {
            uint256 base = sigOff + layer * stride;

            if (layer > 0) {
                // The tree index at the layer below becomes the leaf index here.
                leaf = uint32(tree & ((1 << HP) - 1));
                tree >>= HP;
            }

            node = _wotsPkFromSig(buf, sig, base, node, uint8(layer), tree, leaf);

            // Walk this layer's authentication path.
            uint256 authOff = base + LEN * N;
            uint32 treeIdx = leaf;
            for (uint256 j = 0; j < HP; j++) {
                bytes16 auth = bytes16(_loadN(sig, authOff + j * N));
                if (((leaf >> j) & 1) == 0) {
                    treeIdx = treeIdx / 2;
                    _setAdrs(buf, uint8(layer), tree, ADRS_TREE, 0, uint32(j + 1), treeIdx);
                    _setPayload(buf, 0, node);
                    _setPayload(buf, 1, auth);
                } else {
                    treeIdx = (treeIdx - 1) / 2;
                    _setAdrs(buf, uint8(layer), tree, ADRS_TREE, 0, uint32(j + 1), treeIdx);
                    _setPayload(buf, 0, auth);
                    _setPayload(buf, 1, node);
                }
                node = _thash(buf, 2 * N);
            }
        }
        return node;
    }

    // ---------------------------------------------------------------------
    // Message digest
    // ---------------------------------------------------------------------

    /// @dev H_msg = MGF1-SHA256(R || PK.seed || SHA256(R || PK.seed || PK.root || M), M)
    ///
    /// Two SHA-256 calls in total: one inner digest over the message, then a
    /// single MGF1 iteration. M is 30 bytes and SHA-256 emits 32, so
    /// `ceil(30 / 32) = 1` iteration suffices -- the counter block is still
    /// appended, since MGF1 defines it that way.
    function _hMsg(
        bytes16 r,
        bytes16 pkSeed,
        bytes16 pkRoot,
        bytes32 message
    ) private pure returns (bytes memory out) {
        bytes32 inner = sha256(abi.encodePacked(r, pkSeed, pkRoot, bytes2(0), message));
        bytes32 t0 = sha256(abi.encodePacked(r, pkSeed, inner, uint32(0)));

        out = new bytes(M);
        for (uint256 i = 0; i < M; i++) {
            out[i] = t0[i];
        }
    }

    // ---------------------------------------------------------------------
    // Entry point
    // ---------------------------------------------------------------------

    /// @notice Verifies an SLH-DSA-SHA2-128s signature over a 32-byte message.
    /// @param message   the message being authenticated, the domain-bound 32-byte application intent
    /// @param sig       the 7,856-byte signature
    /// @param pk        the 32-byte public key, PK.seed || PK.root
    /// @return true if and only if the signature is valid
    function verify(
        bytes32 message,
        bytes calldata sig,
        bytes calldata pk
    ) internal view returns (bool) {
        // Structural checks first: rejecting a malformed signature must not
        // cost thousands of hash calls.
        if (sig.length != SIG_BYTES || pk.length != PK_BYTES) {
            return false;
        }

        bytes16 pkSeed = bytes16(_loadN(pk, 0));
        bytes16 pkRoot = bytes16(_loadN(pk, N));
        bytes16 r = bytes16(_loadN(sig, 0));

        bytes memory digest = _hMsg(r, pkSeed, pkRoot, message);

        // Split the digest into the FORS message and the two tree indices.
        bytes memory md = new bytes(MD_BYTES);
        for (uint256 i = 0; i < MD_BYTES; i++) {
            md[i] = digest[i];
        }

        uint64 idxTree = 0;
        for (uint256 i = 0; i < TREE_IDX_BYTES; i++) {
            idxTree = (idxTree << 8) | uint8(digest[MD_BYTES + i]);
        }
        idxTree &= uint64((1 << (H - HP)) - 1);

        uint32 idxLeaf = 0;
        for (uint256 i = 0; i < LEAF_IDX_BYTES; i++) {
            idxLeaf = (idxLeaf << 8) | uint8(digest[MD_BYTES + TREE_IDX_BYTES + i]);
        }
        idxLeaf &= uint32((1 << HP) - 1);

        Buf memory buf = _initBuf(abi.encodePacked(pkSeed));

        bytes16 forsPk = _forsPkFromSig(buf, sig, N, md, idxTree, idxLeaf);

        uint256 htOff = N + K * (A + 1) * N;
        bytes16 root = _htRootFromSig(buf, sig, htOff, forsPk, idxTree, idxLeaf);

        return root == pkRoot;
    }

    /// @dev Loads N bytes from calldata at `offset`, left-aligned in a word.
    function _loadN(bytes calldata data, uint256 offset) private pure returns (bytes32 out) {
        assembly {
            out := calldataload(add(data.offset, offset))
            // Keep only the high N bytes.
            out := and(out, shl(mul(8, sub(32, N)), not(0)))
        }
    }
}

