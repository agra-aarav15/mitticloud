// The package-manager layer: which manager MittiCloud uses to install and build
// a hosted app, and the requests it builds for it.
//
// These tests run on a desktop, where the answer is PATH npm. The Android path
// is exercised by pointing the app root at a temp folder that holds a bundled
// Yarn and setting the embedded flag — exactly what the APK does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const {
  appRoot,
  bundledYarnPath,
  useBundledYarn,
  packageTool,
  packageEnv,
  versionRequest,
  installRequest,
  runRequest,
} = await import('../lib/pkgmgr.js');

function withEnv(vars, fn) {
  const prev = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** A temp app root holding a fake bundled Yarn. Returns its path. */
function fakeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mitticloud-pkg-'));
  const bin = path.join(root, 'bundled-yarn', 'yarn', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'yarn.js'), '// yarn\n');
  return root;
}

test('no bundled Yarn means no bundled path', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mitticloud-pkg-'));
  assert.equal(bundledYarnPath(root), null);
  fs.rmSync(root, { recursive: true, force: true });
});

test('a bundled Yarn is found at <root>/bundled-yarn/yarn/bin/yarn.js', () => {
  const root = fakeRoot();
  assert.equal(bundledYarnPath(root), path.join(root, 'bundled-yarn', 'yarn', 'bin', 'yarn.js'));
  fs.rmSync(root, { recursive: true, force: true });
});

test('on a desktop the manager is npm from PATH', () => {
  withEnv({ MITTICLOUD_APP_ROOT: undefined, MITTICLOUD_EMBEDDED: undefined }, () => {
    assert.ok(fs.existsSync(path.join(appRoot(), 'server', 'index.js')), 'the app root holds server/');
    assert.equal(packageTool(), 'npm');
    // A desktop request is the npm one (a bare `npm` or a cmd.exe shim).
    assert.match(JSON.stringify(installRequest({ full: false })), /npm/);
    assert.match(JSON.stringify(runRequest('build')), /npm/);
    assert.equal(packageEnv({ FOO: '1' }, { home: '/h', cache: '/c' }).HOME, undefined);
  });
});

test('on embedded Android with a bundled Yarn, every request runs Yarn on our node', () => {
  const root = fakeRoot();
  const yarnJs = path.join(root, 'bundled-yarn', 'yarn', 'bin', 'yarn.js');
  withEnv({ MITTICLOUD_APP_ROOT: root, MITTICLOUD_EMBEDDED: '1' }, () => {
    assert.equal(useBundledYarn(), true);
    assert.equal(packageTool(), 'yarn');
    assert.equal(bundledYarnPath(), yarnJs);

    const inst = installRequest({ full: true });
    assert.equal(inst.file, process.execPath, 'runs on our own node');
    assert.ok(inst.args.includes(yarnJs));
    assert.ok(inst.args.includes('install'));
    assert.ok(inst.args.includes('--production=false'), 'a full install keeps dev deps');

    const prod = installRequest({ full: false });
    assert.ok(prod.args.includes('--production=true'), 'a plain install drops dev deps');

    const run = runRequest('start');
    assert.deepEqual(run.args, [yarnJs, 'run', 'start']);

    const ver = versionRequest();
    assert.deepEqual(ver.args, [yarnJs, '--version']);

    const env = packageEnv({ FOO: '1' }, { home: '/tmp/home', cache: '/tmp/cache' });
    assert.equal(env.HOME, '/tmp/home');
    assert.equal(env.YARN_CACHE_FOLDER, '/tmp/cache');
    assert.equal(env.FOO, '1');
    assert.equal(env.YARN_IGNORE_PATH, '1');
  });
  fs.rmSync(root, { recursive: true, force: true });
});

test('an explicitly set HOME is never overwritten', () => {
  const root = fakeRoot();
  withEnv({ MITTICLOUD_APP_ROOT: root, MITTICLOUD_EMBEDDED: '1' }, () => {
    const env = packageEnv({ HOME: '/already' }, { home: '/ignored' });
    assert.equal(env.HOME, '/already');
  });
  fs.rmSync(root, { recursive: true, force: true });
});