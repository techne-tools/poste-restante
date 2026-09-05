# The mailbox sidecar for Poste Restante (SPEC §5 #12) — a Stalwart
# IMAP server pinned to v0.16.20, the EXACT version the house's read-side
# (imapflow adapter + sync drive) is proven against on the dev Mac.
#
# The image carries only the `stalwart` server binary (the release tarball
# contains a single binary — no CLI). Provisioning is the OPERATOR's step:
# the operator applies a plan with `stalwart-cli` (brew on the dev Mac)
# against a temporarily-published recovery port — see deploy.sh
# `sidecar:provision` and the README. The house never sees this image's
# internal bootstrap; it only speaks IMAP with the listener the plan opens.
#
# Pinned by version + platform (the Docker homelab host is x86_64). The
# musl build keeps the image small and glibc-free on alpine:3.20.
FROM alpine:3.20

ARG STALWART_VERSION=v0.16.20
ARG STALWART_SHA256=d95912cb0efde1e248a40fd3ffcf4a67d512479190ab2e5ccaf68f7e3ea36d77

ADD https://github.com/stalwartlabs/stalwart/releases/download/${STALWART_VERSION}/stalwart-x86_64-unknown-linux-musl.tar.gz /tmp/stalwart.tar.gz
RUN echo "${STALWART_SHA256}  /tmp/stalwart.tar.gz" | sha256sum -c - \
    && tar -xzf /tmp/stalwart.tar.gz -C /usr/local/bin \
    && chmod +x /usr/local/bin/stalwart \
    && rm /tmp/stalwart.tar.gz

# Create unprivileged user and directories for RocksDb data and configuration
RUN addgroup -g 10001 -S stalwart && adduser -u 10001 -S -G stalwart stalwart \
    && mkdir -p /opt/stalwart/data /opt/stalwart/etc \
    && chown -R stalwart:stalwart /opt/stalwart

WORKDIR /opt/stalwart

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

USER stalwart

# data/ = the RocksDb store (bind-mount or named volume)
VOLUME ["/opt/stalwart/data"]

EXPOSE 11430

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
