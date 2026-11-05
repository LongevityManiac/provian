export default {
  getItem: async (_k: string) => null,
  setItem: async (_k: string, _v: string) => {},
  removeItem: async (_k: string) => {},
  multiSet: async (_pairs: [string, string][]) => {},
  multiRemove: async (_keys: string[]) => {},
  clear: async () => {},
};
