import { describe, it, expect } from 'vitest';
import { harnessEnableGuidance } from './harness-guidance';
describe('program setup guidance', () => {
 it('every program receives the same local-description setup, with no signed format catalog', () => {
  for (const name of ['openclaw','nimbus',null]) {
   const text=harnessEnableGuidance(name).steps.join('\n');
   expect(text).toContain('describe their location and record format');
   expect(text).toContain('do not repoint');
   expect(text).toContain('writes NO session files');
   expect(text).toContain('ChatGPT sign-in');
   expect(text).not.toMatch(/signed catalog|--watch-transcripts/);
  }
 });
});
