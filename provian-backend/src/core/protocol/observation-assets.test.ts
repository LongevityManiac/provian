import { observationBaseAssets } from './observation-assets';
import { currentProtocolDeployment } from './runtime';
import { predecessorBurnAcceptances } from './predecessor-burns';
import { currentBaseAssets } from '../pvt/wallet-exchange';
jest.mock('./runtime');jest.mock('./predecessor-burns');
const current=`0x${'11'.repeat(20)}`,previous=`0x${'22'.repeat(20)}`,oldest=`0x${'33'.repeat(20)}`;
beforeEach(()=>{
 jest.resetAllMocks();
 (currentProtocolDeployment as jest.Mock).mockResolvedValue({addresses:{kernel:current},manifestHash:`0x${'44'.repeat(32)}`});
 (predecessorBurnAcceptances as jest.Mock).mockResolvedValue([{address:previous,maxBlock:200},{address:oldest,maxBlock:100}]);
});
test('backlogged observations preserve pre-cutoff work without opening retired spending assets',async()=>{
 expect(await observationBaseAssets(100)).toMatchObject({[current]:'PVT',[previous]:'PVT',[oldest]:'PVT'});
 expect(await observationBaseAssets(101)).not.toHaveProperty(oldest);
 expect(await observationBaseAssets(201)).not.toHaveProperty(previous);
 expect(await observationBaseAssets()).toHaveProperty(oldest);
 expect(await currentBaseAssets()).not.toHaveProperty(previous);
});
test('unknown succession or a changed pointer cannot silently drop old work as an unsupported token',async()=>{
 (predecessorBurnAcceptances as jest.Mock).mockRejectedValueOnce(Error('protocol_predecessor_disagreement'));
 await expect(observationBaseAssets(100)).rejects.toThrow('predecessor_disagreement');
 (currentProtocolDeployment as jest.Mock).mockResolvedValueOnce({addresses:{kernel:current},manifestHash:'before'}).mockResolvedValueOnce({addresses:{kernel:current},manifestHash:'after'});
 await expect(observationBaseAssets(100)).rejects.toThrow('pointer_changed');
});
