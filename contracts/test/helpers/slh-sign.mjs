// Deterministic public TEST ONLY seeds. Never load production key material here.
import { slh_dsa_sha2_128s as slh } from '@noble/post-quantum/slh-dsa.js';
import { AbiCoder } from 'ethers';
const [seedHex, messageHex] = process.argv.slice(2);
if (!/^0x[0-9a-fA-F]{96}$/.test(seedHex) || (messageHex && !/^0x[0-9a-fA-F]{64}$/.test(messageHex))) throw Error('Invalid test vector');
const keys = slh.keygen(Buffer.from(seedHex.slice(2), 'hex'));
const signature = messageHex ? slh.sign(Buffer.from(messageHex.slice(2), 'hex'), keys.secretKey, { extraEntropy: false }) : new Uint8Array();
process.stdout.write(AbiCoder.defaultAbiCoder().encode(['bytes', 'bytes'], [keys.publicKey, signature]));
