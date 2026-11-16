import { getAddress } from 'ethers';
import { PROTOCOL_POINTER_PIN } from './pointer-pin.generated';

/** The permanent protocol pointer on Base, checksummed for publication; '' before it is deployed.
 * The current kernel is read through this pointer, never published from a static address. */
export const PROTOCOL_POINTER_ADDRESS: string = PROTOCOL_POINTER_PIN.address ? getAddress(PROTOCOL_POINTER_PIN.address) : '';
