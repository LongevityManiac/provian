/**
 * escrowAdminAck — the one-time acknowledgement a person sees the first time they fund an escrow.
 *
 * Until the Commons Court opens, Provian's admin key resolves disputes on a funded escrow, paying
 * only its parties; a dispute left unresolved past the contract's 30-day timeout can be refunded to
 * the payer by anyone. The sheet says so at the point of use, once per wallet, and is never shown
 * again after the person acknowledges it.
 *
 * The flag is a non-sensitive convenience, kept in AsyncStorage per wallet address. It only decides
 * whether the explanation appears; funding itself is unchanged. An unreadable flag shows the sheet
 * again rather than skipping it.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

const ACK_PREFIX = '@provian_escrow_admin_ack_v1:';

export function escrowAdminAckKey(address: string): string {
  return `${ACK_PREFIX}${address.toLowerCase()}`;
}

/** True only when this wallet has acknowledged before. No wallet, or a failed read, is false. */
export async function hasAcknowledgedEscrowAdmin(address: string | null | undefined): Promise<boolean> {
  if (!address) return false;
  try {
    return (await AsyncStorage.getItem(escrowAdminAckKey(address))) === 'true';
  } catch {
    return false;
  }
}

/** Record the acknowledgement. Best effort: a failed write means the sheet shows again next time. */
export async function recordEscrowAdminAck(address: string | null | undefined): Promise<void> {
  if (!address) return;
  try {
    await AsyncStorage.setItem(escrowAdminAckKey(address), 'true');
  } catch {
    /* shown again next time */
  }
}
