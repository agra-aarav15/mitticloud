import ssh2 from 'ssh2';
const c = new ssh2.Client();
c.on('ready', () => {
  c.sftp((err, sftp) => {
    if (err) { console.log('SFTP_ERR', err.message); c.end(); return; }
    sftp.readdir('.', (e, list) => {
      if (e) { console.log('READDIR_ERR', e.message); c.end(); return; }
      console.log('SFTP_OK entries:', list.map((x) => x.filename).join(',') || '(empty)');
      c.end();
    });
  });
});
c.on('error', (e) => { console.log('CONNECT_ERR', e.message); process.exit(1); });
c.connect({ host: '192.168.31.103', port: 8022, username: 'mitti', password: 'test-ssh-pass-123', hostVerifier: () => true, readyTimeout: 6000 });
