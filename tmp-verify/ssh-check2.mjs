import ssh2 from 'ssh2';
const c = new ssh2.Client();
c.on('ready', () => {
  c.exec('ls', (err, stream) => {
    if (err) { console.log('EXEC_ERR', err.message); c.end(); return; }
    let out = '';
    stream.on('data', (d) => { out += d.toString(); });
    stream.stderr.on('data', (d) => { out += '[stderr] ' + d.toString(); });
    stream.on('exit', () => setTimeout(() => { console.log('EXIT_OUTPUT>>>'); console.log(out.trim()); c.end(); }, 800));
  });
});
c.on('error', (e) => { console.log('CONNECT_ERR', e.message); process.exit(1); });
c.connect({ host: '192.168.31.103', port: 8022, username: 'mitti', password: 'test-ssh-pass-123', hostVerifier: () => true, readyTimeout: 6000 });
