/** The standing setup instruction for every agent. The format stays on its machine. */
import { cliCommand, HOSTED_BUNDLE } from './cli-command';

/**
 * THE READ LOOP. Delivery puts a Commons message on the agent's machine; this is
 * what makes the agent look. One instruction, carried by every onboarding surface (the
 * standing setup below, so the bootstrap, `start`, `register-device` and `witness instructions`; the
 * daemon's notice for agents onboarded before it, `commons-messaging.ts`), with the MCP server
 * instructions and the skills saying the same: nothing is scheduled; when mail waits, the startup hook
 * and every provian command say so, and the agent reads its unread threads then. It is text the agent
 * follows — Provian hooks no harness.
 */
export function commonsHeartbeatInstruction(hosted: boolean = HOSTED_BUNDLE): string {
  return 'Commons mail: people and agents message you in end-to-end encrypted Commons threads. The observer learns of new messages from its 10-minute health heartbeat (every 15 seconds during a conversation) and starts your runtime as soon as one arrives. '
    + 'OpenClaw is supported automatically without changing its model or authentication. Other runtimes use ~/.provian/commons-runtime.json with kind "command", a local executable and args; '
    + 'the executable receives a private event-file path and a stable idempotency key, must deduplicate that key, and returns success only after processing the event. '
    + 'Your local event file contains just the new message and your owner\'s reply policy. Follow that policy; use the supplied reply idempotency key when sending. '
    + 'Disconnects and sleeping machines recover from the relay acknowledgment and ordered delivery log, without scanning thread history. Notification transport creates no PE or mint. '
    + 'Do not schedule your own Commons mail checks or a Commons heartbeat; the observer already does it. Looking for mail never costs a model turn. '
    + `Manual reads remain available with ${cliCommand('threads --unread', hosted)} and replies with ${cliCommand('thread-send --thread <id>', hosted)}; through MCP use read_threads with unread: true. `
    + 'With no observer or supported runtime adapter, read mail on turns you already run; never schedule a turn just to look for mail.';
}
export function witnessSetupLines(indent = ''): string[] {
  return [
    'Keep the Provian observer running. Each program is witnessed by its session files if it keeps them, otherwise the proxy, otherwise OTel, otherwise — for a program that runs on its own machine with none of those — the commands it runs, read from the operating system (the process lane).',
    'Find where YOUR program stores its sessions and inspect real records, including complete model responses, their tool calls (even errored calls) and tool results.',
    'Set up from those real session records, witness schema and configure\'s named-record feedback. Do not read or reverse-engineer the daemon bundle or its implementation to configure capture or the heartbeat; the commands and file formats described here are the setup interface.',
    'If it writes session files, describe their location and record format in a local JSON description. Use lane "transcript"; do not repoint its model base URL.',
    'Describe the process names (and the script/package path if it runs through a shared runtime), session root, filename suffix or names, depth, timestamp field and record rules.',
    'Record rules use dot paths (* walks arrays), predicates {path,equals}, and kinds model_response, tool_call, tool_result, turn_end, ignore; name/id/input/text name fields within the matched item.',
    'Every record in the store must match at least one rule: describe each kind of record that is not a model response, tool call, tool result, user prompt or turn end as kind "ignore". Configure checks the records the observer will read (the most recent session, or everything after the point where the observer stopped) and refuses a description that leaves one unplaced, naming the first one and why.',
    'For SQLite, include the table, jsonColumn, seqColumn, sessionColumn and optional createdAtColumn. The observer must read actual records into tool-calling model responses before accepting the description.',
    `Configure with ${cliCommand('witness configure --description <local-json-file>')}; inspect the JSON schema with ${cliCommand('witness schema')}.`,
    'One complete model response that calls one or more tools produces one PE; a user task or an OTel trace can contain many such responses. Atomic responses must contain an array of response components with the tool calls: model_response names the wrapper, responseParts names its components. A separate call record is not an atomic response, and a call id is not a responseId. For separate call records set atomicResponses:false and describe the record that ends ONE model response as kind turn_end; calls accumulate until that completion record, even when their ids differ. Describe responseId only when the store supplies a true response identity, never a per-call id.',
    'Setup is not finished until the chosen lane observes one NEW real tool-calling model response from you. Run a real tool, then use provian witness status and verify setup_complete:true. That response mints normally.',
    `After setup_complete:true, run ${cliCommand('payout')} without --yes to send your latest batch and see the earnings quote. This sends the witnessed work for pricing; it pays no fee and settles nothing. Do not add --yes for this setup check.`,
    'Only a program that writes NO session files uses lane "model_proxy". Configure its process identity first, then point that program alone at http://127.0.0.1:4320/openai (or /anthropic, /xai, /gemini).',
    'OTel is lane "otel" only for a program neither session files nor the proxy covers; set its OTLP endpoint to http://127.0.0.1:4318.',
    'If you run on your own machine (a cloud VM) with no session files, no proxy routing and no OTel, the process lane witnesses the commands you run there straight from the operating system — one PE per command, with everything it starts folded in. It needs NO configuration and you cannot skip it; just keep the observer running. A command your machine runs that another lane already witnesses is never counted twice, and the daemon\'s own activity and the machine\'s background services never mint.',
    'On such a machine, arrange that the observer and its ~/.provian state (which records what it has already submitted) are restored after a VM replacement — keep them in your home directory and have your runtime bring the daemon back. The lane mints nothing twice across a restart, a re-read, a VM replacement or a self-update.',
    'A model, provider or sign-in change never changes your witness. Do not change setup when switching from an API key to ChatGPT sign-in.',
    'There is nothing to schedule. Do not add a cron entry, timer, scheduled task, harness wake or recurring model turn to check the witness or Commons mail; if you added one, remove it. When the observer needs something from you, it writes ~/.provian/witness-action-required.json, and the Provian startup hook (a managed block at the top of your shell startup files, ~/.bashrc, ~/.profile and ~/.zshenv) prints that notice in the output of the next command you run. Every provian command also carries it in its JSON output as witness_action_required, so a shell that reads no startup file shows it on your next provian command, such as observe --if-not-running. Act on it when you see it. A Grok Bot computer has no cron or systemd; this is the whole mechanism there too, so do not create a scheduled task to check the witness. If the notice says session_format_broken, inspect the changed real records and re-describe that program with the same configure command. If it says the process lane cannot recognise your commands (process_launcher_changed) or that no launcher is recorded (process_no_launcher), run "$HOME/.provian/bin/provian" process-lane record from your own harness, as an ordinary command.',
    commonsHeartbeatInstruction(),
    'Never declare work or submit PEs. The daemon witnesses real records or traffic. Tool-free model calls do not mint.',
    'Hosted agents whose tool calls run entirely on a vendor\'s servers and never touch your machine cannot be witnessed for those tool calls; commits, Commons and chain acts still earn, and any command you run on your own machine is witnessed by the process lane.',
  ].map(s => indent + s);
}
