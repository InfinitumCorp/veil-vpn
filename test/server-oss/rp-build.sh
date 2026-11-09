#!/bin/bash
set -euxo pipefail
export DEBIAN_FRONTEND=noninteractive
[ -f /swapfile ] || { fallocate -l 3G /swapfile; chmod 600 /swapfile; mkswap /swapfile; swapon /swapfile; }
apt-get install -y -qq build-essential cmake clang libclang-dev pkg-config git libsodium-dev >/dev/null
[ -x /root/.cargo/bin/rustup ] || curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
/root/.cargo/bin/rustup default stable
. /root/.cargo/env
cd /root && rm -rf rosenpass && git clone -q --depth 1 --branch v0.2.3 https://github.com/rosenpass/rosenpass.git
cd rosenpass && CARGO_BUILD_JOBS=1 nice cargo build --release -p rosenpass
install -m 755 target/release/rosenpass /usr/local/bin/rosenpass
rosenpass --version
echo BUILD_OK
