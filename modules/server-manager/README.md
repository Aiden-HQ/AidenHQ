# server-manager

## What it does

Keeps the Linux servers you list patched over SSH, one machine at a time: it checks for updates, installs security updates on a
schedule or when you ask, and reboots inside a quiet window when a kernel update needs it. It speaks only Ubuntu LTS and Debian
stable, and only through three typed operations — check, patch and reboot — so there is no command to type and no ad hoc service
restart. Every maintenance run is one approval record with the machine, the package hash and the outcome; every machine publishes
one sanitized status row (distro, pending, security, reboot needed, disk, last check) to the warehouse, never a key, address or
package list. A private key is held only at connect time: named from the Sign-ins panel, written to a mode-0600 temp file for one
connection, never logged, returned or recorded.

## Connect

Nothing to connect. Add a server on the Servers page (Team → Servers), then type its private key in the board's Sign-ins panel under
the page, by the name the server entry uses. The first connection pins the host key it sees (fine to start) and reports the
fingerprint; a changed key refuses every run until you re-pin it from the page. Set "expected fingerprint" in Advanced to have the
first connection checked against the one your provider shows.

## What agents get

The `server-manager` teammate reads config and status (`server_manager_config`, `server_manager_status`) and runs a check
(`server_manager_check`, granted by name because it uses a key and a private host). It holds no write: a patch or reboot always
comes from a schedule or your own click, never an agent's judgement. It is woken when a run fails, a host key changes, a service
stopped after an install, or a reboot's consent expired, and reports what happened in plain words, saying what it did not do.

## New installs

Not in the default bundle. Once added, nothing runs until you add and enable a machine: no check, no patch, no reboot, and the
heartbeat starts off under quiet start. Keys are typed in the Sign-ins panel; a machine's four required fields are name, address,
user and key.
