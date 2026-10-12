import ssh2 from 'ssh2';
const c = new ssh2.Client();
const out = [];
c.on('ready', () => {
  c.exec('echo SSH_DOOR_OK; pwd; ls', (err, stream) => {
    if (err) { console.log('EXEC_ERR', err.message); c.end(); return; }
    stream.on('data', (d) => out.push(d.toString()));
    stream.on('close', () => { console.log(out.join('')); c.end(); });
  });
});
c.on('error', (e) => { console.log('CONNECT_ERR', e.message); process.exit(1); });
c.connect({ host: '192.168.31.103', port: 8022, username: 'mitti', password: 'test-ssh-pass-123', hostVerifier: () => true, readyTimeout: 6000 });
