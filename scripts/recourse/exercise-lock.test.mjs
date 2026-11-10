import { test, expect, vi } from 'vitest';
import { exerciseMutationLock } from './exercise-lock.mjs';

test.each([['fund','fund'],['exercise','exercise'],['fund','exercise'],['exercise','fund']])(
  '%s excludes overlapping %s before opening-state reads', async (first, second) => {
    const lock=exerciseMutationLock(), calls=[];
    let release;
    const preflight=new Promise(resolve=>{release=resolve;});
    const pending=lock.run(async()=>{calls.push(first+':read');await preflight;calls.push(first+':write');});
    expect(lock.busy).toBe(true);
    await expect(lock.run(async()=>{calls.push(second+':read');calls.push(second+':write');})).rejects.toThrow('exercise_sequence_busy');
    expect(calls).toEqual([first+':read']);
    release();await pending;expect(lock.busy).toBe(false);
    await lock.run(async()=>{calls.push(second+':retry');});
    expect(calls).toEqual([first+':read',first+':write',second+':retry']);
  },
);
test('failed preflight releases the same lock without running a write',async()=>{
  const lock=exerciseMutationLock(),write=vi.fn();
  await expect(lock.run(async()=>{throw Error('preflight');})).rejects.toThrow('preflight');
  expect(lock.busy).toBe(false);await lock.run(write);expect(write).toHaveBeenCalledOnce();
});
