import { reconcileScheduler, type SchedulerManifest, type LiveJob } from './scheduler-manifest';
const manifest: SchedulerManifest = {
  location:'local',project:'test',serviceUrl:'https://product.run.app',
  endpoints:[{path:'/v1/internal/scheduler/product',required:true,job:'product-job',schedule:'0 * * * *'}],nonHttpJobs:[],
};
const own: LiveJob = {name:'product-job',state:'ENABLED',schedule:'0 * * * *',endpoint:'/v1/internal/scheduler/product',uri:'https://product.run.app/v1/internal/scheduler/product'};
function check(liveJobs: LiveJob[]) { return reconcileScheduler({manifest,codeEndpoints:manifest.endpoints.map(e=>e.path),liveJobs}); }
it('separate service schedules do not count as orphan product routes',()=>{
  expect(check([own,{...own,name:'other-job',endpoint:'/v1/internal/scheduler/other',uri:'https://other.run.app/v1/internal/scheduler/other'}]).ok).toBe(true);
});
it('RED: a required product job redirected to another service is missing',()=>{
  const result=check([{...own,uri:'https://other.run.app/v1/internal/scheduler/product'}]);
  expect(result.ok).toBe(false);expect(result.errors.some(e=>e.includes('MISSING CRON'))).toBe(true);
});
it('RED: an orphan route on the product service remains rejected',()=>{
  const result=check([own,{...own,name:'orphan-job',endpoint:'/v1/internal/scheduler/removed',uri:'https://product.run.app/v1/internal/scheduler/removed'}]);
  expect(result.ok).toBe(false);expect(result.errors.some(e=>e.includes('ORPHAN JOB'))).toBe(true);
});
