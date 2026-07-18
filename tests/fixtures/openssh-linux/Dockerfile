FROM debian:bookworm-slim

RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends openssh-server \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --shell /bin/sh sshmcp \
    && echo 'sshmcp:unused-fixture-password' | chpasswd \
    && install -d -m 0700 -o sshmcp -g sshmcp /home/sshmcp/.ssh \
    && install -m 0600 -o sshmcp -g sshmcp /dev/null /home/sshmcp/.ssh/authorized_keys \
    && install -d -m 0755 /run/sshd

COPY sshd_config /etc/ssh/sshd_config

EXPOSE 22

CMD ["/usr/sbin/sshd", "-D", "-e", "-f", "/etc/ssh/sshd_config"]
