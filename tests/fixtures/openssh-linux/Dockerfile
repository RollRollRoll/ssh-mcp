FROM debian:bookworm-slim AS helper-build

RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends build-essential \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build
COPY ignore-term.c ./
COPY ignore-term-shell.c ./
RUN cc -O2 -Wall -Wextra -o ignore-term ignore-term.c \
    && cc -O2 -Wall -Wextra -o ignore-term-shell ignore-term-shell.c

FROM debian:bookworm-slim

RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends openssh-server \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --shell /bin/sh sshmcp \
    && useradd --create-home --shell /usr/local/bin/ignore-term-shell sshmcpignore \
    && echo 'sshmcp:unused-fixture-password' | chpasswd \
    && echo 'sshmcpignore:unused-fixture-password' | chpasswd \
    && install -d -m 0700 -o sshmcp -g sshmcp /home/sshmcp/.ssh \
    && install -m 0600 -o sshmcp -g sshmcp /dev/null /home/sshmcp/.ssh/authorized_keys \
    && install -d -m 0700 -o sshmcpignore -g sshmcpignore /home/sshmcpignore/.ssh \
    && install -m 0600 -o sshmcpignore -g sshmcpignore /dev/null /home/sshmcpignore/.ssh/authorized_keys \
    && install -d -m 0755 /run/sshd

COPY sshd_config /etc/ssh/sshd_config
COPY --from=helper-build /build/ignore-term /usr/local/bin/ignore-term
COPY --from=helper-build /build/ignore-term-shell /usr/local/bin/ignore-term-shell

EXPOSE 22

CMD ["/usr/sbin/sshd", "-D", "-e", "-f", "/etc/ssh/sshd_config"]
