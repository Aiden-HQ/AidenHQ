#!/bin/sh
# The live smoke test's in-container half (spec §14: "one live smoke test on a throwaway Ubuntu container in CI for the exact
# commands the adapter runs"). It runs inside a throwaway Ubuntu LTS container, with no key and no network, and the container is
# the host: every command below is a line the module itself builds.
#
# The test (test/live-apt.test.ts) passes each command line as an environment variable, already quoted exactly as the SSH
# transport quotes it for a host's shell (ssh.ts quoteWords), so `sh -c "$UPDATE"` here runs what the host's shell would run.
# This script only builds a private local apt repository and reads back what apt did; it decides nothing the test asserts.
#
# The container runs as root, so `sudo -n` has nothing to elevate: a stand-in on PATH execs its arguments unchanged, which keeps
# the module's exact words (`sudo -n flock … apt-get …`) in the line while proving nothing about sudo itself. The stand-in says
# so on stderr, so the output shows it was used.
set -eu
export DEBIAN_FRONTEND=noninteractive
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

R=/srv/smoke
PKG=smoke-pkg
OLD=1.0
NEW=2.0
NEWER=3.0

say() { printf '### %s\n' "$1"; }

say "sudo-stand-in"
mkdir -p /usr/local/sbin
cat > /usr/local/sbin/sudo <<'SUDO'
#!/bin/sh
# The container is already root: `sudo -n <argv>` is `<argv>`, unchanged. It refuses anything but `-n`, so a command that would
# have prompted is a failure here rather than a silent pass.
[ "${1:-}" = "-n" ] || { echo "sudo stand-in: only -n is accepted, got '$*'" >&2; exit 1; }
shift
exec "$@"
SUDO
chmod 0755 /usr/local/sbin/sudo
echo "sudo-stand-in-ready"

# A private apt repository in the container: three versions of one package (so a pin to the middle one is a real choice), and a
# package whose postinst fails so `dpkg --audit` has something real to report. Nothing here is the module's code; it is the
# fixture the module's commands run against.
say "build-repo"
mkdir -p "$R/repo/dists/noble/main/binary-amd64" "$R/repo/pool" "$R/build"
build() {
  name="$1"; ver="$2"; postinst="$3"; d="$R/build/$name-$ver"
  mkdir -p "$d/DEBIAN" "$d/usr/share/$name" "$d/etc"
  printf 'Package: %s\nVersion: %s\nArchitecture: all\nMaintainer: smoke <smoke@example.invalid>\nDescription: server-manager live smoke package\n' "$name" "$ver" > "$d/DEBIAN/control"
  printf '%s %s\n' "$name" "$ver" > "$d/usr/share/$name/version"
  printf 'shipped %s\n' "$ver" > "$d/etc/$name.conf"
  printf 'shipped %s\n' "$ver" > "$d/etc/$name-untouched.conf"
  printf '/etc/%s.conf\n/etc/%s-untouched.conf\n' "$name" "$name" > "$d/DEBIAN/conffiles"
  if [ -n "$postinst" ]; then printf '#!/bin/sh\nexit 1\n' > "$d/DEBIAN/postinst"; chmod 0755 "$d/DEBIAN/postinst"; fi
  dpkg-deb --build --root-owner-group "$d" "$R/repo/pool/${name}_${ver}_all.deb" >/dev/null
}
build "$PKG" "$OLD" ""
build "$PKG" "$NEW" ""
build "$PKG" "$NEWER" ""
build smoke-broken 1.0 broken
P="$R/repo/dists/noble/main/binary-amd64/Packages"
: > "$P"
for f in "$R"/repo/pool/*.deb; do
  {
    dpkg-deb -f "$f"
    printf 'Filename: ./pool/%s\n' "$(basename "$f")"
    printf 'Size: %s\n' "$(stat -c %s "$f")"
    printf 'MD5sum: %s\n' "$(md5sum "$f" | cut -d' ' -f1)"
    printf 'SHA256: %s\n' "$(sha256sum "$f" | cut -d' ' -f1)"
    printf '\n'
  } >> "$P"
done
{
  printf 'Origin: smoke\nLabel: smoke\nSuite: noble\nCodename: noble\nArchitectures: amd64\nComponents: main\n'
  printf 'Date: %s\n' "$(date -Ru)"
  printf 'MD5Sum:\n %s %s main/binary-amd64/Packages\n' "$(md5sum "$P" | cut -d' ' -f1)" "$(stat -c %s "$P")"
  printf 'SHA256:\n %s %s main/binary-amd64/Packages\n' "$(sha256sum "$P" | cut -d' ' -f1)" "$(stat -c %s "$P")"
} > "$R/repo/dists/noble/Release"
# The private repository is served over loopback HTTP rather than read as `file:`, because apt answers a `file:` source with a
# `0 B` download and this test needs the real size of a real download. `--network none` still leaves `lo` up, so this is the only
# network the container has: nothing leaves it, and the run is the same offline every day.
perl /smoke/serve.pl "$R/repo" 8099 >/dev/null 2>&1 &
SERVER=$!
trap 'kill "$SERVER" 2>/dev/null || true' EXIT
i=0
until perl -MIO::Socket::INET -e 'exit(IO::Socket::INET->new(PeerAddr=>"127.0.0.1",PeerPort=>8099,Proto=>"tcp") ? 0 : 1)' 2>/dev/null; do
  i=$((i + 1))
  [ "$i" -lt 50 ] || { echo "the loopback repository did not come up" >&2; exit 1; }
  sleep 0.1
done
printf 'deb [trusted=yes] http://127.0.0.1:8099 noble main\n' > /etc/apt/sources.list.d/smoke.list
# The image's own archives are not this test's business: the private repository is the only source. The sandbox user is root
# because the container is already root and has no `_apt` account to drop to.
mv /etc/apt/sources.list.d/ubuntu.sources /etc/apt/sources.list.d/ubuntu.sources.disabled 2>/dev/null || true
printf 'APT::Sandbox::User "root";\n' > /etc/apt/apt.conf.d/00-smoke-sandbox

say "update"
sh -c "$UPDATE"

say "seed"
# The module only ever runs --only-upgrade, so the fixture's old version is installed first, as a host would already have it.
apt-get install -y "$PKG=$OLD" >/dev/null
printf 'installed-before %s\n' "$(dpkg-query -W -f='${Version}' "$PKG")"
# Two conffiles, one edited locally and one left as shipped. The two Dpkg::Options words are proved together by what happens to
# each: --force-confold keeps the edited one, and --force-confdef (dpkg's default action) takes the new version for the untouched
# one. With either word alone one of the two would keep the old file, so both have to reach dpkg for this to hold.
printf 'local edit\n' > "/etc/$PKG.conf"

say "simulate"
sh -c "$SIMULATE"

say "estimate"
# The space a run needs is the exact list's own download size. apt prints `Need to get …` for a real install, but not for `-s`:
# its simulation stops before the download summary. `--print-uris` runs the same resolution over the same list and prints the
# summary without fetching anything, so this is the same number the module reads from a real install's own output.
sh -c "$ESTIMATE"

say "install"
sh -c "$INSTALL" > "$R/install.log" 2>&1
printf 'installed-after %s\n' "$(dpkg-query -W -f='${Version}' "$PKG")"
printf 'payload %s\n' "$(cat "/usr/share/$PKG/version")"
printf 'conffile-modified %s\n' "$(cat "/etc/$PKG.conf")"
printf 'conffile-untouched %s\n' "$(cat "/etc/$PKG-untouched.conf")"
# apt's own record of the argv it ran: the one line that names --only-upgrade is this install's.
printf 'apt-history %s\n' "$(grep -m1 '^Commandline: .*--only-upgrade' /var/log/apt/history.log || true)"

say "audit-clean"
dpkg --audit
printf 'audit-clean-end\n'

say "hold"
apt-mark hold "$PKG" >/dev/null
printf 'holds %s\n' "$(apt-mark showhold | tr '\n' ' ')"
printf 'policy-begin\n'
apt-cache policy "$PKG"
printf 'policy-end\n'

say "break"
# A package whose postinst fails is left half-configured: `dpkg --audit` reports it, which is the state the module refuses to
# patch over. Its own failing install is expected here, so it is not allowed to end the script.
dpkg -i "$R/repo/pool/smoke-broken_1.0_all.deb" >/dev/null 2>&1 || true

say "audit-broken"
dpkg --audit
printf 'audit-broken-end\n'
