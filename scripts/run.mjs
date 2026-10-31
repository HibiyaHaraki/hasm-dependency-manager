import { readFile, appendFile } from 'node:fs/promises';
import { GitHub } from '../src/github.mjs';
import { Manager } from '../src/manager.mjs';

const args = process.argv.slice(2);
if (args.some((arg) => arg !== '--dry-run')) throw new Error('Only --dry-run is supported.');
const config = JSON.parse(await readFile(new URL('../repositories.json', import.meta.url), 'utf8'));
const lines = [];
const dryRun = args.includes('--dry-run');
const manager = new Manager(new GitHub(process.env.GH_TOKEN, { readOnly: dryRun }), config, {
  dryRun,
  log(message) {
    console.log(message);
    lines.push(message);
  },
});
try {
  await manager.run();
} catch (error) {
  console.error(error);
  lines.push(`FAILED: ${error.message}`);
  process.exitCode = 1;
} finally {
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `## Dependency manager\n\n${lines.join('\n\n')}\n`);
  }
}
