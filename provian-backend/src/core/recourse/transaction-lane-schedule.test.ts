import { runRecourseMinute } from './transaction-lane-schedule';

test('a failing membership sweep is reported and the lane still sends what is queued after it', async () => {
  const lane = jest.fn(async (budget: number) => budget);
  const logged = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  const result = await runRecourseMinute({ now: () => 0, lane, debitBacklog: async () => 0,
    sweep: async () => { throw Error('recourse_automatic_owner'); } });
  expect(result.automatic_membership).toEqual({ error: 'recourse_automatic_owner' });
  expect(lane).toHaveBeenCalledTimes(2);
  expect(result.drain).toBe(52_000);
  // Logged, not only returned: scheduler request logs are sampled.
  expect(logged).toHaveBeenCalledWith('[recourse-lane] membership sweep failed; retrying next minute:', 'recourse_automatic_owner');
});
