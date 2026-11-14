#!/bin/sh
# Starts what systemd would on a computer (docker's daemon, Windscribe's helper and app), logs in to Windscribe the first
# time, then runs windscout with this script's arguments. Needs `docker run --privileged`.

# cgroup v2: move this container's processes out of its root cgroup, so dockerd can hand controllers to its own containers
# (as moby's hack/dind does)
if [ -f /sys/fs/cgroup/cgroup.controllers ]; then
  mkdir -p /sys/fs/cgroup/init
  xargs -rn1 < /sys/fs/cgroup/cgroup.procs > /sys/fs/cgroup/init/cgroup.procs 2>/dev/null || :
  sed -e 's/ / +/g' -e 's/^/+/' < /sys/fs/cgroup/cgroup.controllers > /sys/fs/cgroup/cgroup.subtree_control 2>/dev/null || :
fi
mkdir -p /dev/net && { [ -c /dev/net/tun ] || mknod /dev/net/tun c 10 200; }
dockerd > /var/log/dockerd.log 2>&1 &
/opt/windscribe/helper > /dev/null 2>&1 &
chown ws: /home/ws # a new volume belongs to root

for i in $(seq 30); do docker info > /dev/null 2>&1 && break; sleep 1; done
docker info > /dev/null 2>&1 || { echo "docker's daemon didn't start (did you pass --privileged?):" >&2; tail -5 /var/log/dockerd.log >&2; exit 1; }

# Windscribe's CLI refuses root: the app, its login and windscout run as ws
# The host's app settings, mounted at /host/Windscribe2.conf (Linux; on macOS and Windows, a file with just the session):
# its session goes in this app's settings before it starts, as a parallel scan's workers get it (src/worker.ts), so the app
# logs in with it instead of asking for a password. Copied as root: ws may not be the mounted file's owner
[ -e /host/Windscribe2.conf ] && install -o ws -m 600 /host/Windscribe2.conf /tmp/host.conf
exec runuser -u ws -- env HOME=/home/ws sh -c '
  [ -e /tmp/host.conf ] && node --input-type=module -e "
    import { mkdirSync, readFileSync, rmSync, writeFileSync } from \"node:fs\";
    import { dirname } from \"node:path\";
    import { iniValue, SETTINGS, withSession } from \"/app/dist/windscribe.js\";
    const host = readFileSync(\"/tmp/host.conf\", \"utf8\"), authHash = iniValue(host, \"authHash\");
    rmSync(\"/tmp/host.conf\");
    if (!authHash) process.exit(console.error(\"The host app has no session: log in here instead\"));
    let ini = \"\";
    try { ini = readFileSync(SETTINGS, \"utf8\"); } catch {} // first run: no settings yet
    mkdirSync(dirname(SETTINGS), { recursive: true });
    writeFileSync(SETTINGS, withSession(ini, { userId: iniValue(host, \"userId\") ?? \"\", authHash }));"
  /opt/windscribe/Windscribe > /dev/null 2>&1 &
  # logging in with a session takes a while: wait for it to end either way (as the worker does)
  for i in $(seq 180); do windscribe-cli status 2>/dev/null | grep -qE "^Login( state)?: +(Logged in|Logged out|Error)" && break; sleep 1; done
  # its login exits 0 on a wrong password too: ask again until the app says logged in
  until windscribe-cli status | grep -q "Logged in"; do
    [ -t 0 ] || { echo "Windscribe is not logged in: run the container with -it to log in" >&2; exit 1; }
    windscribe-cli login
  done
  exec windscout "$@"' windscout "$@"
