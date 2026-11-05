// Minimal expo-device stub for vitest (node env). The real module pulls in
// the Expo winter runtime, which does not load under node.
export const isDevice = true;
export const deviceName = 'test-device';
export const modelName = 'test-model';
export const osName = 'iOS';
export const osVersion = '18.0';
export async function getDeviceTypeAsync() { return 1; }
