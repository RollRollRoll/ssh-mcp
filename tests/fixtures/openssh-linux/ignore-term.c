#include <signal.h>
#include <unistd.h>

int main(void) {
  const int signals[] = {SIGTERM, SIGHUP, SIGINT, SIGQUIT};
  const char started[] = "started\n";

  for (unsigned long index = 0; index < sizeof(signals) / sizeof(signals[0]); index++) {
    if (signal(signals[index], SIG_IGN) == SIG_ERR) return 1;
  }
  if (write(STDOUT_FILENO, started, sizeof(started) - 1) < 0) return 1;
  for (;;) pause();
}
