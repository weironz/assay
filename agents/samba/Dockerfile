# syntax=docker/dockerfile:1
ARG BUILDER_IMAGE=rust:1.99-alpine
ARG BUILD_FROM=source-artifact
FROM ${BUILDER_IMAGE} AS builder
WORKDIR /source
COPY Cargo.toml Cargo.lock ./
COPY src ./src
RUN --mount=type=secret,id=proxy_ca \
    --mount=type=cache,id=assay-rust-registry,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,id=assay-agent-musl-target,target=/source/target,sharing=locked \
    if [ -f /run/secrets/proxy_ca ]; then export CARGO_HTTP_CAINFO=/run/secrets/proxy_ca SSL_CERT_FILE=/run/secrets/proxy_ca; fi; \
    cargo build --locked --release --bin assay-samba-agent \
    && mkdir -p /out && cp target/release/assay-samba-agent /out/assay-samba-agent

FROM scratch AS source-artifact
COPY --from=builder /out/assay-samba-agent /assay-samba-agent

# Local CI can compile once in a disposable Rust container with host-side
# caches, avoiding large compiler snapshots on copy-based Docker drivers.
FROM scratch AS prebuilt-artifact
COPY --from=release-artifacts /assay-samba-agent /assay-samba-agent

FROM ${BUILD_FROM} AS artifact

# testparm is a fixed, one-shot configuration validator, not a management daemon.
# samba-server additionally provides smbstatus for the read-only sessions view
# (/v1/sessions); no Samba daemon from this image is ever started.
FROM alpine:3.23
ARG SAMBA_VALIDATION_DIRS="/var/lib/samba/private /var/cache/samba /run/samba /run/samba-pids"
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export SSL_CERT_FILE=/run/secrets/proxy_ca; fi; \
    apk add --no-cache samba-common-tools samba-server \
    && mkdir -p ${SAMBA_VALIDATION_DIRS}
COPY --from=artifact /assay-samba-agent /assay-samba-agent
USER 10001:10001
ENTRYPOINT ["/assay-samba-agent"]
CMD ["/config/agent.json"]
