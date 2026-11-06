import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyProjectEnvOverrides, portPool, projectConfig } from './config.js';

test('PORT_POOL: the desk default is unchanged, and a range gives the 10-slot server layout', () => {
  assert.deepEqual(portPool({}), [8000, 8001, 8002]);
  const server = portPool({ PORT_POOL: '8100-8109' });
  assert.equal(server.length, 10);
  assert.deepEqual([server[0], server[9]], [8100, 8109]);
});

test('PORT_POOL overlapping another pool is refused at first read', () => {
  assert.throws(() => portPool({ PORT_POOL: '8000-8011' }), /port 8010 is in both PORT_POOL \(Django\) and ONESHOT_APP_PORTS \(Django\)/);
  assert.throws(() => portPool({ PORT_POOL: '8030' }), /local tests/);
  assert.throws(() => portPool({ PORT_POOL: '8100-8101', ONESHOT_APP_PORTS: '9100' }),
    /port 9100 is in both PORT_POOL webpack \(\+1000\) and ONESHOT_APP_PORTS \(Django\)/);
  assert.throws(() => portPool({ PORT_POOL: '8000,9000' }), /port 9000 is in both PORT_POOL \(Django\) and PORT_POOL webpack/);
  assert.doesNotThrow(() => portPool({ PORT_POOL: '8100-8109', ONESHOT_APP_PORTS: '8010-8012' }));
});

test('ONESHOT_CONCURRENCY and CONTEXT_REPO override project.json, which keeps its defaults', () => {
  const file = projectConfig();
  const c = { concurrency: 1, contextRepo: { ...file.contextRepo } };
  applyProjectEnvOverrides(c, {});
  assert.equal(c.concurrency, 1);
  applyProjectEnvOverrides(c, { ONESHOT_CONCURRENCY: '10', CONTEXT_REPO: '/srv/erp' });
  assert.equal(c.concurrency, 10);
  assert.equal(c.contextRepo.path, '/srv/erp');
  assert.equal(c.contextRepo.gitlabProject, file.contextRepo.gitlabProject);
  assert.throws(() => applyProjectEnvOverrides(c, { ONESHOT_CONCURRENCY: 'ten' }), /not a positive whole number/);
  assert.throws(() => applyProjectEnvOverrides(c, { ONESHOT_CONCURRENCY: '0' }), /not a positive whole number/);
});
