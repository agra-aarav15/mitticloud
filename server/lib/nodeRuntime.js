// The Node program to spawn for a hosted app.
//
// On a desktop this is process.execPath — a real executable. On the phone it is
// NOT: the runtime is libnode.so, a shared library Android refuses to execve()
// (a child started that way dies with SIGABRT). The APK therefore also ships
// libmittinode.so, a real executable that loads its sibling libnode.so, and the
// app passes its native library folder in MITTICLOUD_NATIVE_DIR. That folder is
// the one place Android lets an app execute from.
//
// Lives in its own module (not apprunner.js) so the package-manager layer can
// use it without importing apprunner — which imports the package-manager layer.
import fs from 'node:fs';
import path from 'node:path';

export function nodeRuntime() {
  const dir = process.env.MITTICLOUD_NATIVE_DIR;
  if (dir) {
    const native = path.join(dir, 'libmittinode.so');
    try {
      if (fs.statSync(native).isFile()) return native;
    } catch {
      /* fall through to the desktop runtime */
    }
  }
  return process.execPath;
}