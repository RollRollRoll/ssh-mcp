#include <signal.h>
#include <unistd.h>

int main(int argc, char *argv[]) {
  const int signals[] = {SIGTERM, SIGHUP, SIGINT, SIGQUIT};

  for (unsigned long index = 0; index < sizeof(signals) / sizeof(signals[0]); index++) {
    if (signal(signals[index], SIG_IGN) == SIG_ERR) return 1;
  }
  (void)argc;
  execv("/bin/sh", argv);
  return 127;
}
