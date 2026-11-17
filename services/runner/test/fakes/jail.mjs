// The sandbox binaries the runner's startup probe needs on PATH: a fake pasta, a bwrap that finishes the netjail
// handshake (--info-fd 3 names its pid, --block-fd 4 waits for "go"), and an ip that reports only loopback. A job's
// command runs after the jail's shell wrapper, as the real bwrap would run it; tests still run no namespaces. With these
// on PATH the runner starts on any test host, while production keeps failing closed.
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function fakeJail(bin, log) {
  writeFileSync(join(bin, "bwrap"), `#!/bin/sh
export FAKE_LOG='${log}'
awk 'BEGIN {
  s = "{\\"kind\\":\\"bwrap\\",\\"data\\":["
  for (i = 1; i < ARGC && ARGV[i] != "--"; i++) { a = ARGV[i]; gsub(/\\\\/, "\\\\\\\\", a); gsub(/"/, "\\\\\\"", a); s = s (i > 1 ? "," : "") "\\"" a "\\"" }
  print s "]}"
}' "$@" >> "$FAKE_LOG"
info=3; block=4
while [ $# -gt 0 ]; do
  case "$1" in
    --info-fd) info=$2; shift 2;;
    --block-fd) block=$2; shift 2;;
    --) shift; break;;
    *) shift;;
  esac
done
if [ -e /proc/$$/fd/$info ]; then printf '{"child-pid": %s}\\n' $$ >&$info; fi
if [ -e /proc/$$/fd/$block ]; then read -r go <&$block; fi
if [ "$1" = /bin/sh ] && [ "$2" = -c ]; then shift 3; fi
if [ "$1" = aidenhq-jail ]; then shift; fi
exec "$@"
`);
  writeFileSync(join(bin, "pasta"), "#!/bin/sh\nexit 0\n");
  writeFileSync(join(bin, "ip"), "#!/bin/sh\ncase \"$*\" in *route*) exit 0;; esac\necho '1: lo    inet 127.0.0.1/8 scope host lo'\n");
  for (const name of ["bwrap", "pasta", "ip"]) chmodSync(join(bin, name), 0o755);
}
