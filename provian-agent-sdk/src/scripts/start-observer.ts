#!/usr/bin/env node
/**
 * start-observer - Run the Provian observer daemon in the foreground.
 *
 * Normally started by launchd/systemd/schtasks after `register-device`. Can also
 * be run manually: `npx @provian/agent-sdk observe`.
 *
 * The daemon body lives in ../observer/run-daemon (runObserverDaemon) so the
 * hosted onboarding bundle can run the SAME observer from its own `observe`
 * subcommand without depending on an npm-published SDK.
 */

import { runObserverDaemon } from '../observer/run-daemon';
import { removePidFile } from '../observer/service';

runObserverDaemon(process.argv.slice(2)).catch(err => {
  console.error(`Unexpected error: ${err}`);
  removePidFile();
  process.exit(1);
});
