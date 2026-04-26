# --- builder ----------------------------------------------------------------
FROM rust:1.91-slim-bookworm AS builder

WORKDIR /src

RUN apt-get update \
 && apt-get install -y --no-install-recommends pkg-config \
 && rm -rf /var/lib/apt/lists/*

# Cache dependency compilation by copying manifests first.
COPY Cargo.toml Cargo.lock ./
RUN mkdir src \
 && echo 'fn main() {}' > src/main.rs \
 && cargo build --release --locked \
 && rm -rf src target/release/imghost target/release/imghost.d

# Real source.
COPY migrations ./migrations
COPY src ./src
RUN touch src/main.rs && cargo build --release --locked

# Empty directory we will COPY --chown into the runtime image so the volume
# mount at /var/lib/imghost is owned by the nonroot user, not root.
RUN install -d -m 0755 /opt/imghost-data

# --- runtime ----------------------------------------------------------------
FROM gcr.io/distroless/cc-debian12:nonroot

COPY --from=builder --chown=nonroot:nonroot /opt/imghost-data /var/lib/imghost
COPY --from=builder /src/target/release/imghost /usr/local/bin/imghost

USER nonroot:nonroot
WORKDIR /var/lib/imghost
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/imghost"]
