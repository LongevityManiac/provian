"""The Provian sealed box: a PE sealed to a recipient's x25519 message key (the linked human's, or
a person's own). Byte-compatible with the TypeScript SDK's ``sealToAnchor`` / ``openWithAnchor``
(``provian-agent-sdk/src/agent-key-recovery.ts``) and the relay's ``sealed-box.ts``, so a copy this
SDK seals opens on the person's phone::

    ephemeral x25519 keypair; shared = X25519(eph_secret, recipient_pub)
    okm   = HKDF-SHA256(ikm=shared, salt=eph_pub || recipient_pub, info="provian-agent-recovery-v1", 56)
    key   = okm[0:32], nonce = okm[32:56]                 (XChaCha20-Poly1305, 24-byte nonce)
    aad   = 0x01 || recipient_pub
    box   = 0x01 || eph_pub || ciphertext || tag

``cryptography`` has X25519, HKDF and IETF ChaCha20-Poly1305 but not the X variant;
XChaCha20-Poly1305 is ChaCha20-Poly1305 under the subkey HChaCha20(key, nonce[0:16]) with the
12-byte nonce 0x00000000 || nonce[16:24], so HChaCha20 is the one function written out here. The
relay's pinned vector (produced by the SDK's implementation) keeps them identical.
"""

import base64
import os
import struct
from typing import Optional

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey, X25519PublicKey
from cryptography.hazmat.primitives.ciphers.aead import ChaCha20Poly1305
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

_VERSION = 0x01
_INFO = b"provian-agent-recovery-v1"
_MASK = 0xFFFFFFFF


def _rotl(v: int, n: int) -> int:
    return ((v << n) | (v >> (32 - n))) & _MASK


def hchacha20(key: bytes, nonce16: bytes) -> bytes:
    """HChaCha20: the ChaCha20 core over (constants, key, 16-byte nonce), keeping words 0-3 and 12-15."""
    if len(key) != 32 or len(nonce16) != 16:
        raise ValueError("hchacha20_bad_input")
    s = [0x61707865, 0x3320646E, 0x79622D32, 0x6B206574]
    s += list(struct.unpack("<8I", key))
    s += list(struct.unpack("<4I", nonce16))

    def qr(a: int, b: int, c: int, d: int) -> None:
        s[a] = (s[a] + s[b]) & _MASK
        s[d] = _rotl(s[d] ^ s[a], 16)
        s[c] = (s[c] + s[d]) & _MASK
        s[b] = _rotl(s[b] ^ s[c], 12)
        s[a] = (s[a] + s[b]) & _MASK
        s[d] = _rotl(s[d] ^ s[a], 8)
        s[c] = (s[c] + s[d]) & _MASK
        s[b] = _rotl(s[b] ^ s[c], 7)

    for _ in range(10):
        qr(0, 4, 8, 12); qr(1, 5, 9, 13); qr(2, 6, 10, 14); qr(3, 7, 11, 15)  # noqa: E702
        qr(0, 5, 10, 15); qr(1, 6, 11, 12); qr(2, 7, 8, 13); qr(3, 4, 9, 14)  # noqa: E702
    return struct.pack("<8I", *(s[w] for w in (0, 1, 2, 3, 12, 13, 14, 15)))


def _xchacha(key: bytes, nonce24: bytes) -> "tuple[ChaCha20Poly1305, bytes]":
    return ChaCha20Poly1305(hchacha20(key, nonce24[:16])), b"\x00\x00\x00\x00" + nonce24[16:24]


def _raw_public(public: X25519PublicKey) -> bytes:
    return public.public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)


def _key_and_nonce(shared: bytes, eph_pub: bytes, recipient_pub: bytes) -> "tuple[bytes, bytes]":
    okm = HKDF(algorithm=hashes.SHA256(), length=56, salt=eph_pub + recipient_pub, info=_INFO).derive(shared)
    return okm[:32], okm[32:56]


def seal_to_key(recipient_public: bytes, plaintext: bytes, ephemeral_secret: Optional[bytes] = None) -> bytes:
    """Seal ``plaintext`` to an x25519 public key. ``ephemeral_secret`` is for test vectors only."""
    if len(recipient_public) != 32:
        raise ValueError("recipient_public_key_must_be_32_bytes")
    eph = X25519PrivateKey.from_private_bytes(ephemeral_secret if ephemeral_secret is not None else os.urandom(32))
    eph_pub = _raw_public(eph.public_key())
    shared = eph.exchange(X25519PublicKey.from_public_bytes(recipient_public))
    key, nonce = _key_and_nonce(shared, eph_pub, recipient_public)
    aead, nonce12 = _xchacha(key, nonce)
    return bytes([_VERSION]) + eph_pub + aead.encrypt(nonce12, plaintext, bytes([_VERSION]) + recipient_public)


def open_with_key(recipient_secret: bytes, box: bytes) -> bytes:
    """Open a box with the recipient's x25519 secret. Raises on a wrong key or a tampered box."""
    if len(box) < 1 + 32 + 16 or box[0] != _VERSION:
        raise ValueError("sealed_box_malformed")
    secret = X25519PrivateKey.from_private_bytes(recipient_secret)
    eph_pub = box[1:33]
    recipient_pub = _raw_public(secret.public_key())
    shared = secret.exchange(X25519PublicKey.from_public_bytes(eph_pub))
    key, nonce = _key_and_nonce(shared, eph_pub, recipient_pub)
    aead, nonce12 = _xchacha(key, nonce)
    return aead.decrypt(nonce12, box[33:], bytes([_VERSION]) + recipient_pub)


def to_b64u(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def from_b64u(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))
