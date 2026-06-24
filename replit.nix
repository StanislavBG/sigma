{ pkgs }: {
  # System packages for the Replit workspace. Node 22 + pnpm match package.json
  # ("engines.node" >= 22, "packageManager": "pnpm@10.33.0"). sqlite + a C toolchain
  # are here so a native SQLite driver (better-sqlite3, used by the Node/D1 adapter —
  # see replit.md) can compile if a prebuilt binary is unavailable.
  deps = [
    pkgs.nodejs_22
    pkgs.corepack          # provides the pinned pnpm via `corepack enable`
    pkgs.sqlite            # sqlite3 CLI for inspecting/seeding the corpus
    pkgs.python3           # node-gyp dependency for native module builds
    pkgs.gcc               # native module compilation (better-sqlite3)
    pkgs.gnumake
  ];
}
