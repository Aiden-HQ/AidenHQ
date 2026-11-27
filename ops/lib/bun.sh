# Bun, the one package manager, on this host: `ensureBun` puts the pinned version first on PATH, downloading it once from
# Bun's GitHub release and refusing a download whose sha256 isn't the pinned one. No root: it lives in the user's own data
# dir, one folder per version (${XDG_DATA_HOME:-~/.local/share}/aidenhq/bun-<version>/bun), so the unprivileged apply can
# install it before it needs it and a version bump never touches the running one. Node (already on every host) checks and
# unzips it, so no unzip or sha256sum is needed. aidenhq-distro's .github/release/install-bun.sh pins the same files.
# Sourced by ops/apply-config-work.sh (before any checkout), scripts/bootstrap.sh and the kernel's compile check
# (kernel/src/compile-check.ts). Run by hand (`. ops/lib/bun.sh && ensureBun`), it puts Bun on that shell's PATH.
AIDENHQ_BUN_VERSION=1.4.5

ensureBun() {
  local dir="${XDG_DATA_HOME:-$HOME/.local/share}/aidenhq/bun-$AIDENHQ_BUN_VERSION" f sum tmp
  if [ ! -x "$dir/bun" ]; then
    case "$(uname -s)-$(uname -m)" in
      # The baseline build: it runs on any amd64 CPU (the standard one needs AVX2, which some VMs don't expose).
      Linux-x86_64) f=bun-linux-x64-baseline.zip sum=dcb23a18a1c2fff12d57bcef696dbbb42eb67fde29f43816ecb595459a24c463 ;;
      Linux-aarch64|Linux-arm64) f=bun-linux-aarch64.zip sum=18656a3bf0ea5641f5796ae4213b75255579a70a0fded2f337933785568cdf84 ;;
      Darwin-x86_64) f=bun-darwin-x64.zip sum=a4972e778cce4b6a194d7d289f326aa61576d71d80b7a53e9da2f3739566e5fd ;;
      Darwin-arm64) f=bun-darwin-aarch64.zip sum=b5d6bc2e13caf14e57c89661e89efd073ff16165b41bfe43882616410609cd10 ;;
      *) echo "bun: no pinned Bun for $(uname -s) $(uname -m)" >&2; return 1 ;;
    esac
    # Downloaded and unpacked in a folder of its own, beside the target, then renamed into place: two installs at once never
    # touch each other's files.
    mkdir -p "$dir" && tmp="$(mktemp -d "$dir/.part.XXXXXX")" || return 1
    if ! curl -fsSL --retry 3 --connect-timeout 20 --max-time 300 -o "$tmp/$f" "https://github.com/oven-sh/bun/releases/download/bun-v1.4.5/$f"; then
      rm -rf "$tmp"; echo "bun: downloading $f failed" >&2; return 1
    fi
    # The zip's one file named .../bun, inflated, written beside the target and renamed into place.
    if ! node -e '
      const fs = require("fs"), zlib = require("zlib"), crypto = require("crypto");
      const [zip, sum, out] = process.argv.slice(1), b = fs.readFileSync(zip);
      const got = crypto.createHash("sha256").update(b).digest("hex");
      if (got !== sum) throw new Error(`sha256 is ${got}, not the pinned ${sum}`);
      let eocd = b.length - 22;
      while (eocd >= 0 && b.readUInt32LE(eocd) !== 0x06054b50) eocd--;
      if (eocd < 0) throw new Error("not a zip");
      for (let p = b.readUInt32LE(eocd + 16), n = b.readUInt16LE(eocd + 10); n-- > 0;) {
        const method = b.readUInt16LE(p + 10), size = b.readUInt32LE(p + 20), nl = b.readUInt16LE(p + 28);
        const name = b.toString("utf8", p + 46, p + 46 + nl), at = b.readUInt32LE(p + 42);
        p += 46 + nl + b.readUInt16LE(p + 30) + b.readUInt16LE(p + 32);
        if (!/(^|\/)bun$/.test(name)) continue;
        const start = at + 30 + b.readUInt16LE(at + 26) + b.readUInt16LE(at + 28), data = b.subarray(start, start + size);
        fs.writeFileSync(out, method === 8 ? zlib.inflateRawSync(data) : data, { mode: 0o755 });
        process.exit(0);
      }
      throw new Error("no bun in the zip");
    ' "$tmp/$f" "$sum" "$tmp/bun"; then
      rm -rf "$tmp"; echo "bun: $f could not be verified or unpacked" >&2; return 1
    fi
    "$tmp/bun" --version | grep -qx "$AIDENHQ_BUN_VERSION" && mv -f "$tmp/bun" "$dir/bun" \
      || { rm -rf "$tmp"; echo "bun: the unpacked binary is not $AIDENHQ_BUN_VERSION" >&2; return 1; }
    rm -rf "$tmp"
  fi
  # First on PATH even when it is there already behind another Bun: the pinned one always wins.
  export PATH="$dir:$PATH"
}
