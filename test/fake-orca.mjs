// A stand-in for the Orca CLI, for testing `factory dispatch`: logs every call (with the spec it was
// piped) to FAKE_ORCA_LOG and answers like Orca. FAKE_ORCA_FAIL=worker-start makes starts fail.
import fs from 'node:fs';

const args = process.argv.slice(2);
let input = '';
if (!process.stdin.isTTY) for await (const chunk of process.stdin) input += chunk;
fs.appendFileSync(process.env.FAKE_ORCA_LOG, JSON.stringify({ args, input: input ? input.slice(0, 200) : undefined }) + '\n');
const [, sub] = args;
const reply = (result) => console.log(JSON.stringify({ ok: true, result }));
if (process.env.FAKE_ORCA_FAIL === sub) {
  console.log(JSON.stringify({ ok: false, error: { message: `${sub} failed (fake)` } }));
  process.exit(1);
}
const n = fs.readFileSync(process.env.FAKE_ORCA_LOG, 'utf8').trim().split('\n').length;
if (sub === 'worker-start') reply({ dispatchId: `ctx_fake${n}`, workspace: 'repo::C:/wt/factory-x' });
else if (sub === 'worker-stop') reply({ state: 'stopped' });
else if (sub === 'worker-release') reply({ state: 'released' });
else reply({});
