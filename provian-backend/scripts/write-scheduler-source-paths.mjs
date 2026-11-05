import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const require=createRequire(import.meta.url);
const {scanSchedulerEndpointsFromSource}=require('../dist/core/deployment/scheduler-manifest.js');
const paths=scanSchedulerEndpointsFromSource(resolve('src'));
if(!paths.length)throw new Error('empty scheduler source catalog');
writeFileSync(resolve('dist/scheduler-source-paths.json'),JSON.stringify(paths)+'\n');
console.log(`Published ${paths.length} scheduler source paths`);
