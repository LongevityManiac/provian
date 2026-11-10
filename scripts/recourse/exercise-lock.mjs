/** One shared simulator clock and copied funding balance. Acquire before even
 * reading the opening state so concurrent requests cannot spend it twice. */
export function exerciseMutationLock() {
  let busy = false;
  return {
    get busy() { return busy; },
    async run(action) {
      if (busy) throw Error('exercise_sequence_busy');
      busy = true;
      try { return await action(); }
      finally { busy = false; }
    },
  };
}
