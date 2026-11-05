import {buildPeBugSignal} from './diagnostic-signals';
const SCALE = 10n ** 18n;
describe('sealed value diagnostic signal',()=>{
  it('creates a signal only at or above the configured threshold', () => {
    expect(buildPeBugSignal({
      peId: 'pe-low', sealedValueAtomic: (249n * SCALE).toString(),
      thresholdAtomic: 250n * SCALE, recordedAtMs: 1,
    })).toBeNull();
    expect(buildPeBugSignal({
      peId: 'pe-boundary', sealedValueAtomic: (250n * SCALE).toString(),
      thresholdAtomic: 250n * SCALE, recordedAtMs: 1,
    })).toMatchObject({ pe_id: 'pe-boundary', delivered_at_ms: null });
  });

});
