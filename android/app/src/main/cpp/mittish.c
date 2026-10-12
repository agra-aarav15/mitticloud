// mittish — a tiny PTY proxy, so an SSH session gets a real interactive shell.
//
// Why this exists: the server's shell channel used plain pipes, so the child had
// no controlling terminal. Anything that asks isatty() got "no", and interactive
// tools (top, less, vim, any line-editing prompt, colours) either refused to run
// or misbehaved. A full shell needs a TTY.
//
// This program allocates a PTY, runs the requested program on the slave side,
// and proxies bytes between its own stdin/stdout and the PTY master. Window-size
// changes arrive on fd 3 as lines of "R <rows> <cols>\n" (the SSH layer writes
// them when the client sends a window-change request), so a resize reflows.
//
// Usage:  mittish <program> [args...]
//   env MITTI_PTY_ROWS / MITTI_PTY_COLS set the first size (default 24 x 80)
//
// Plain C + forkpty: needs only libc. Android has forkpty in bionic (no libutil).
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <pty.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/select.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <termios.h>
#include <unistd.h>

static pid_t child_pid = -1;

static void set_winsize(int fd, int rows, int cols) {
  struct winsize ws;
  memset(&ws, 0, sizeof(ws));
  ws.ws_row = (unsigned short)rows;
  ws.ws_col = (unsigned short)cols;
  ioctl(fd, TIOCSWINSZ, &ws);
}

static int env_int(const char *name, int dflt) {
  const char *v = getenv(name);
  if (!v || !*v) return dflt;
  int n = atoi(v);
  return n > 0 ? n : dflt;
}

// On the way out, hang up the whole child session so nothing is left running.
static void hangup_child(void) {
  if (child_pid > 0) {
    kill(-child_pid, SIGHUP);
    kill(child_pid, SIGHUP);
  }
}

static void on_signal(int sig) {
  (void)sig;
  hangup_child();
  _exit(0);
}

int main(int argc, char **argv) {
  if (argc < 2) {
    fprintf(stderr, "usage: mittish <program> [args...]\n");
    return 2;
  }

  int rows = env_int("MITTI_PTY_ROWS", 24);
  int cols = env_int("MITTI_PTY_COLS", 80);

  struct winsize ws;
  memset(&ws, 0, sizeof(ws));
  ws.ws_row = (unsigned short)rows;
  ws.ws_col = (unsigned short)cols;

  int master = -1;
  pid_t pid = forkpty(&master, NULL, NULL, &ws);
  if (pid < 0) {
    fprintf(stderr, "mittish: forkpty: %s\n", strerror(errno));
    return 127;
  }

  if (pid == 0) {
    // Child: the PTY slave is already stdin/stdout/stderr and our controlling
    // terminal, so a program that wants a TTY gets one.
    execvp(argv[1], &argv[1]);
    fprintf(stderr, "mittish: cannot run %s: %s\n", argv[1], strerror(errno));
    _exit(127);
  }

  child_pid = pid;
  set_winsize(master, rows, cols);
  signal(SIGTERM, on_signal);
  signal(SIGHUP, on_signal);
  signal(SIGINT, on_signal);

  const int in_fd = STDIN_FILENO;
  const int out_fd = STDOUT_FILENO;
  int ctl_fd = 3; // optional control pipe; absent when the parent did not pass one
  if (fcntl(ctl_fd, F_GETFD) < 0) ctl_fd = -1;

  char buf[65536];
  int client_open = 1;
  int running = 1;

  while (running) {
    fd_set rfds;
    FD_ZERO(&rfds);
    FD_SET(master, &rfds);
    int maxfd = master;
    if (client_open) {
      FD_SET(in_fd, &rfds);
      if (in_fd > maxfd) maxfd = in_fd;
    }
    if (ctl_fd >= 0) {
      FD_SET(ctl_fd, &rfds);
      if (ctl_fd > maxfd) maxfd = ctl_fd;
    }

    int n = select(maxfd + 1, &rfds, NULL, NULL, NULL);
    if (n < 0) {
      if (errno == EINTR) continue;
      break;
    }

    // Output from the shell -> the client.
    if (FD_ISSET(master, &rfds)) {
      ssize_t r = read(master, buf, sizeof(buf));
      if (r > 0) {
        ssize_t off = 0;
        while (off < r) {
          ssize_t w = write(out_fd, buf + off, (size_t)(r - off));
          if (w <= 0) { running = 0; break; }
          off += w;
        }
      } else {
        running = 0; // EOF or error: the shell is done
      }
    }

    // Input from the client -> the shell.
    if (running && client_open && FD_ISSET(in_fd, &rfds)) {
      ssize_t r = read(in_fd, buf, sizeof(buf));
      if (r > 0) {
        ssize_t off = 0;
        while (off < r) {
          ssize_t w = write(master, buf + off, (size_t)(r - off));
          if (w <= 0) break;
          off += w;
        }
      } else {
        // Client hung up: deliver an EOT so the shell can exit cleanly, then
        // stop listening for input. Output keeps flowing until the shell ends.
        char eot = 4;
        ssize_t w = write(master, &eot, 1);
        (void)w;
        client_open = 0;
      }
    }

    // Resize requests from the SSH layer.
    if (ctl_fd >= 0 && FD_ISSET(ctl_fd, &rfds)) {
      char cb[256];
      ssize_t r = read(ctl_fd, cb, sizeof(cb) - 1);
      if (r <= 0) {
        ctl_fd = -1;
      } else {
        cb[r] = '\0';
        char *line = cb;
        while (line && *line) {
          char *nl = strchr(line, '\n');
          if (nl) *nl = '\0';
          if (*line == 'R') {
            int rr = 0, cc = 0;
            if (sscanf(line, "R %d %d", &rr, &cc) == 2 && rr > 0 && cc > 0) {
              set_winsize(master, rr, cc);
            }
          }
          line = nl ? nl + 1 : NULL;
        }
      }
    }
  }

  close(master);
  hangup_child();
  // Reap the child so it does not linger as a zombie. It has been hung up, so
  // this returns promptly; a wait that would block is bounded anyway because the
  // process is about to exit and init adopts anything still alive.
  int status = 0;
  (void)waitpid(pid, &status, 0);
  // The shell's exit status is the command's exit status — pass it through so
  // `exit 7` over SSH really reports 7.
  if (WIFEXITED(status)) return WEXITSTATUS(status);
  if (WIFSIGNALED(status)) return 128 + WTERMSIG(status);
  return 0;
}