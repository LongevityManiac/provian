import { readFileSync } from 'fs';
import { resolve } from 'path';
import { cloudRunSizing } from './__test-helpers__/cloud-run-sizing';

const deployed = readFileSync(resolve(__dirname, '../../../deploy-env.sh'), 'utf8');
it('reads actual relay deployment sizing (not an independently assumed memory size)', () => {
  expect(cloudRunSizing(deployed)).toEqual({vcpus:1,memoryGiB:2,concurrency:40});
  expect(cloudRunSizing(deployed.replace(/--memory=\S+/,'--memory=512Mi'))).toEqual({vcpus:1,memoryGiB:0.5,concurrency:40});
});
it('RED: refuses absent, ambiguous and nonpositive deployment sizing', () => {
  expect(() => cloudRunSizing(deployed.replace(/--memory=\S+/,'--memory=0Gi'))).toThrow('cloud_run_sizing_invalid');
  expect(() => cloudRunSizing(deployed.replace('--cpu=1','--cpu=0'))).toThrow('cloud_run_sizing_invalid');
  expect(() => cloudRunSizing(deployed.replace('--concurrency=40', '--concurrency=0'))).toThrow('cloud_run_sizing_invalid');
  expect(() => cloudRunSizing('')).toThrow('cloud_run_sizing_not_unique');
  expect(() => cloudRunSizing(deployed+'\n--memory=1Gi\n')).toThrow('cloud_run_sizing_not_unique');
});
