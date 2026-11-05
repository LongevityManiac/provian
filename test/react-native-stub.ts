export const Platform = { OS: 'test', select: (obj: any) => obj?.default ?? obj };
export const NativeModules = {};
export const TurboModuleRegistry = {
  getEnforcing: (_name: string) => ({}),
  get: (_name: string) => ({}),
};
export const Linking = { openURL: async () => {}, canOpenURL: async () => false };
export const Alert = { alert: () => {} };
export const AppState = { currentState: 'active', addEventListener: () => ({ remove: () => {} }) };
export const Dimensions = { get: () => ({ width: 0, height: 0 }) };
export default {};
