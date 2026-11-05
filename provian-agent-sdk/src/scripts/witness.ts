import fs from 'fs';
import { loadCredentials } from './credentials';
import { configureProgram, readPrograms } from '../observer/program-witness';
import { witnessSetupLines } from '../witness-setup';
import { isDirectCliEntry } from './cli-entry';
export async function runWitnessCli(args = process.argv.slice(2)): Promise<void> {
  if (args[0] === 'schema') {
    console.log(JSON.stringify({ program: 'your-program', processNames: ['your-executable'], scriptPaths: ['/absolute/script-or-package'], lane: 'transcript', session: {
      root: '/absolute/session-store', maxDepth: 5, suffix: '.jsonl', timestamp: 'timestamp', responseId:'response_id', atomicResponses:true, responseParts:'content.*',
      rules: [ { kind: 'model_response', where: [{path:'kind',equals:'assistant_response'}] },
        { kind: 'tool_call', at: 'content.*', where:[{path:'type',equals:'tool_call'}], name: 'name', id: 'id', input: 'arguments' },
        { kind: 'tool_result', where: [{path:'kind',equals:'result'}], id: 'call_id', text:'text' },
        { kind: 'ignore', at:'content.*', where:[{path:'type',equals:'text'}], text:'text' } ]
    } }, null, 2)); return;
  }
  if (args[0] === 'instructions' || args[0] === undefined) { console.log(witnessSetupLines().join('\n')); return; }
  if (args[0] === 'status') { console.log(JSON.stringify(readPrograms().map(p => ({program:p.program,lane:p.lane,setupAtMs:p.setupAtMs,setup_complete:!!p.readyAtMs,first_tool_response_at_ms:p.readyAtMs??null})), null, 2)); return; }
  if (args[0] !== 'configure') throw new Error('Use witness configure --description <local-json-file>, instructions, schema or status');
  if (loadCredentials()?.ownerType !== 'agent') throw new Error('Tool-call witnesses are for agent devices only');
  const pos = args.indexOf('--description'); if (pos < 0 || !args[pos+1]) throw new Error('A local description JSON file is required');
  const result = configureProgram(JSON.parse(fs.readFileSync(args[pos+1], 'utf8')) as unknown);
  console.log(JSON.stringify({program:result.program.program,lane:result.program.lane,validated_records:result.records,validated_tool_calls:result.calls,validated_turns:result.turns,stored:'machine-only',setup_complete:!!result.program.readyAtMs,next:result.program.readyAtMs?'Keep the observer running':'Perform a real tool turn, then check witness status' }));
}
if (isDirectCliEntry(module)) void runWitnessCli().catch(e => { console.error(e.message); process.exitCode=1; });
