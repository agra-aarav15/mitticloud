// mittinode — a runnable front end for the embedded Node runtime.
//
// Why this exists: the server runs inside libnode.so (a shared library started
// through JNI). Android API 29+ refuses execve() on anything an app can write,
// so a hosted app cannot be launched out of app storage — the old code spawned
// process.execPath (which IS libnode.so) and the child died with SIGABRT.
//
// The one folder an app may execute from is the APK's native library folder,
// which is also where libnode.so already lives. So this program is compiled as
// an ordinary PIE executable but PACKAGED under a .so name, which makes Android
// extract it into that folder with the executable bit set.
//
// It resolves its siblings at run time (no rpath, no soname guessing), loads
// libnode.so, finds node::Start and hands over the command line — the same
// entry the JNI shim calls. Plain C, so it needs nothing but libc and libdl.
#include <dlfcn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

typedef int (*node_start_fn)(int argc, char **argv);

// The folder holding this executable, read from the kernel rather than argv[0]
// so a relative or symlinked launch still resolves correctly.
static int self_dir(char *out, size_t cap) {
  ssize_t n = readlink("/proc/self/exe", out, cap - 1);
  if (n <= 0) return 0;
  out[n] = '\0';
  char *slash = strrchr(out, '/');
  if (!slash) return 0;
  *slash = '\0';
  return 1;
}

int main(int argc, char **argv) {
  char dir[4096];
  if (!self_dir(dir, sizeof(dir))) {
    fprintf(stderr, "mittinode: cannot locate its own folder\n");
    return 127;
  }

  char path[4352];

  // Load the C++ runtime first and keep it global, so libnode.so's NEEDED
  // entry is already satisfied when the linker resolves it.
  snprintf(path, sizeof(path), "%s/libc++_shared.so", dir);
  dlopen(path, RTLD_NOW | RTLD_GLOBAL);

  snprintf(path, sizeof(path), "%s/libnode.so", dir);
  void *node = dlopen(path, RTLD_NOW | RTLD_GLOBAL);
  if (!node) {
    fprintf(stderr, "mittinode: %s\n", dlerror());
    return 127;
  }

  // node::Start(int, char**) — fixed C++ mangling in the prebuilt libnode.so
  // (confirmed in the arm64, armeabi-v7a and x86_64 binaries).
  node_start_fn start =
      (node_start_fn)dlsym(node, "_ZN4node5StartEiPPc");
  if (!start) {
    fprintf(stderr, "mittinode: node::Start not found in libnode.so\n");
    return 127;
  }

  // Node expects argv[0] to be the program name; keep the rest untouched so
  // arguments reach the child script exactly as given. argc+1 slots, so this
  // is a small, safe stack allocation.
  char **args = (char **)__builtin_alloca((size_t)(argc + 1) * sizeof(char *));
  args[0] = "node";
  for (int i = 1; i < argc; i++) args[i] = argv[i];
  args[argc] = NULL;

  return start(argc, args);
}