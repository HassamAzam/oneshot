/**
 * `npm run dashboard-user -- <add|remove|list> [username]` — who can sign in to
 * the dashboard. This is the only way an account is made; the dashboard has no
 * signup page.
 *
 * `add` asks for the password twice without echoing it, or reads one line from
 * stdin when stdin is not a terminal, so it never appears in the command line
 * or shell history. Adding a name that exists resets its password.
 */
import { createInterface } from 'node:readline';
import { MIN_PASSWORD, USERNAME, USERS_FILE, hashPassword, loadUsers, saveUsers } from './dashboard/users.js';

function ask(prompt: string): Promise<string> {
  return new Promise((done) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const write = (rl as unknown as { _writeToOutput: (s: string) => void });
    write._writeToOutput = (s: string) => { if (s.startsWith(prompt)) process.stdout.write(prompt); };
    rl.question(prompt, (answer) => {
      rl.close();
      process.stdout.write('\n');
      done(answer);
    });
  });
}

async function readPassword(): Promise<string> {
  if (!process.stdin.isTTY) {
    let input = '';
    for await (const chunk of process.stdin) input += chunk;
    return input.split('\n')[0] ?? '';
  }
  const first = await ask('Password: ');
  if (first !== (await ask('Again: '))) throw new Error('the two passwords differ');
  return first;
}

async function main(): Promise<void> {
  const [cmd, raw] = process.argv.slice(2);
  const users = { ...loadUsers() };
  const name = (raw ?? '').toLowerCase();

  if (cmd === 'list') {
    const names = Object.keys(users).sort();
    console.log(names.length ? names.join('\n') : `No accounts yet in ${USERS_FILE}.`);
    return;
  }
  if ((cmd !== 'add' && cmd !== 'remove') || !raw) {
    throw new Error('usage: npm run dashboard-user -- <add|remove|list> [username]');
  }
  if (cmd === 'remove') {
    if (!Object.hasOwn(users, name)) throw new Error(`no account named ${name}`);
    delete users[name];
    saveUsers(users);
    console.log(`Removed ${name}; their session ends on their next request.`);
    return;
  }
  if (!USERNAME.test(name)) throw new Error('a username is 2-32 characters: a-z, 0-9, _ and -, starting with a letter or digit');
  const password = await readPassword();
  if (password.length < MIN_PASSWORD) throw new Error(`a password needs at least ${MIN_PASSWORD} characters`);
  const existed = Object.hasOwn(users, name);
  users[name] = { hash: hashPassword(password), createdAt: users[name]?.createdAt ?? Date.now() };
  saveUsers(users);
  console.log(`${existed ? 'Reset the password for' : 'Added'} ${name} in ${USERS_FILE}.`);
}

main().catch((err: Error) => {
  console.error(`dashboard-user: ${err.message}`);
  process.exit(1);
});
