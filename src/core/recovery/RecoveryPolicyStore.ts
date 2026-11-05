import { RecoveryPolicy } from './types';
import * as SecureStore from 'expo-secure-store';

const POLICY_KEY = 'provian_recovery_policy';

export const RecoveryPolicyStore = {
    async getPolicy(): Promise<RecoveryPolicy | null> {
        try {
            const json = await SecureStore.getItemAsync(POLICY_KEY);
            return json ? JSON.parse(json) : null;
        } catch (error) {
            console.error('Failed to load recovery policy', error);
            return null;
        }
    },

    async setPolicy(policy: RecoveryPolicy): Promise<void> {
        try {
            await SecureStore.setItemAsync(POLICY_KEY, JSON.stringify(policy), {
                keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
            });
        } catch (error) {
            console.error('Failed to save recovery policy', error);
            throw error;
        }
    },

    async clearPolicy(): Promise<void> {
        await SecureStore.deleteItemAsync(POLICY_KEY);
    }
};
