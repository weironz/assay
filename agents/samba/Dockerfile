# syntax=docker/dockerfile:1
ARG BUILDER_IMAGE=rust:1.99-alpine
FROM ${BUILDER_IMAGE} AS builder
WORKDIR /source
COPY Cargo.toml Cargo.lock ./
COPY src ./src
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export CARGO_HTTP_CAINFO=/run/secrets/proxy_ca SSL_CERT_FILE=/run/secrets/proxy_ca; fi; \
    cargo build --locked --release

FROM scratch
COPY --from=builder /source/target/release/assay-samba-agent /assay-samba-agent
USER 10001:10001
ENTRYPOINT ["/assay-samba-agent"]
CMD ["/config/agent.json"]
