#!/bin/sh
#  §3 item 4 — restart drill: the observer daemon comes back on a box with NO cron and NO
# systemd, after a reboot (docker restart: processes gone, the filesystem — /home included — kept)
# and after an instance move (a FRESH container from the pristine image with only /home/box carried
# over, the "Update Grok Bot's Computer" shape), with no human action and nothing the agent is told
# to do: the next shell the agent opens (every tool call opens one) runs the restart hook.
#
# Usage:  sh provian-agent-sdk/scripts/restart-drill.sh [path/to/dist-bundle/agent.js]
# Build the bundle first:  (cd provian-agent-sdk && npm run build:bootstrap)
#
# The daemon needs no relay registration to show a restart: the drill writes a minimal local
# credentials file (fake device key/secret, owner human) pointing the relay at a closed loopback
# port (http://127.0.0.1:9), so every relay call fails fast and the daemon keeps running.
#
# Containers used: d495-restart-drill, d495-restart-drill-moved (removed at start and end). No
# other container or volume is touched.
set -eu

BUNDLE="${1:-$(cd "$(dirname "$0")/.." && pwd)/dist-bundle/agent.js}"
IMAGE="${D495_DRILL_IMAGE:-node:22-bookworm-slim}"
C=d495-restart-drill
C2=d495-restart-drill-moved
WORK=$(mktemp -d)
[ -f "$BUNDLE" ] || { echo "bundle not found: $BUNDLE (build it: npm run build:bootstrap)"; exit 1; }

say() { printf '\n=== %s\n' "$*"; }
bx() { docker exec -u box -w /home/box "$1" sh -c "$2"; }
# The daemon's state, read the way the hook reads it: the pidfile, whether that pid is alive, and
# whether its /proc cmdline is our `observe` process.
state() {
  docker exec -u box -w /home/box "$1" sh -c '
    pid=$(cat ~/.provian/observer.pid 2>/dev/null || true)
    if [ -n "$pid" ] && [ -r /proc/$pid/cmdline ]; then
      printf "pidfile=%s alive=yes cmdline=%s\n" "$pid" "$(tr "\000" " " < /proc/$pid/cmdline)"
    else
      printf "pidfile=%s alive=no\n" "${pid:-none}"
    fi'
}
running() {
  docker exec -u box -w /home/box "$1" sh -c '
    pid=$(cat ~/.provian/observer.pid 2>/dev/null || true)
    [ -n "$pid" ] && [ -r /proc/$pid/cmdline ] && tr "\000" " " < /proc/$pid/cmdline | grep -q "agent.js observe"'
}
wait_running() { i=0; while [ $i -lt 40 ]; do running "$1" && return 0; sleep 0.5; i=$((i + 1)); done; return 1; }
wait_stopped() { i=0; while [ $i -lt 40 ]; do running "$1" || return 0; sleep 0.5; i=$((i + 1)); done; return 1; }
kill_daemon() { bx "$1" 'kill $(cat ~/.provian/observer.pid) 2>/dev/null || true'; wait_stopped "$1"; }
unthrottle() { bx "$1" 'rm -f ~/.provian/restart-hook.stamp'; }

docker rm -f "$C" "$C2" >/dev/null 2>&1 || true

say "box: $IMAGE, no cron, no systemd"
docker run -d --name "$C" "$IMAGE" sleep infinity >/dev/null
docker exec "$C" sh -c 'useradd -m -s /bin/bash box'
docker exec "$C" sh -c 'command -v cron crond crontab systemctl || echo "cron/crontab/systemctl: none present"'

say "install from the BUILT bundle (the hosted service install path: repair → installService → detached + restart hook)"
docker cp "$BUNDLE" "$C:/home/box/agent.js"
docker exec "$C" sh -c 'mkdir -p /home/box/.provian && mv /home/box/agent.js /home/box/.provian/agent.js && chown -R box:box /home/box'
bx "$C" 'umask 077; printf "PROVIAN_DEVICE_KEY=pvd_restart_drill\nPROVIAN_DEVICE_SECRET=restart_drill_secret\nPROVIAN_RELAY_URL=http://127.0.0.1:9\nPROVIAN_OWNER_TYPE=human\n" > ~/.provian/credentials'
bx "$C" 'node ~/.provian/agent.js repair' || true
wait_running "$C"
state "$C"
bx "$C" 'grep -E "\[observer\] (started|restart hook)" ~/.provian/observer.log | tail -3'
bx "$C" 'echo "--- ~/.bashrc head:"; head -3 ~/.bashrc; echo "--- ~/.profile head:"; head -3 ~/.profile; ls -l ~/.provian/bin/provian-ensure; [ -e ~/.bash_profile ] && echo "~/.bash_profile EXISTS (must not be created)" || echo "~/.bash_profile absent (not created)"'

say "ALREADY-INSTALLED box (no hook yet, e.g. a v35 install): the daemon's own start writes the hook — the self-update path"
kill_daemon "$C"
bx "$C" 'node -e "const r=require(\"fs\");for(const f of [\".bashrc\",\".profile\"]){const p=process.env.HOME+\"/\"+f;r.writeFileSync(p,r.readFileSync(p,\"utf8\").replace(/# >>> provian-restart-hook[^]*?# <<< provian-restart-hook <<<\n/,\"\"))}"; rm -f ~/.provian/bin/provian-ensure; grep -c provian-restart-hook ~/.bashrc ~/.profile || true'
# Started exactly as a detached v35 daemon (and a self-update re-exec) starts: PROVIAN_SUPERVISOR=detached.
bx "$C" 'cd ~ && PROVIAN_SUPERVISOR=detached setsid node ~/.provian/agent.js observe >>~/.provian/observer.log 2>&1 </dev/null &'
wait_running "$C"
sleep 2
bx "$C" 'grep "\[observer\] restart hook" ~/.provian/observer.log | tail -1; grep -c provian-restart-hook ~/.bashrc ~/.profile; ls -l ~/.provian/bin/provian-ensure'

say "REBOOT: docker restart (every process gone, /home kept)"
docker restart "$C" >/dev/null
state "$C"
if running "$C"; then echo "FAIL: daemon running before any shell opened"; exit 1; fi
echo "daemon NOT running after reboot (as expected)"

say "agent tool-call shell, interactive: bash -ic 'true'"
docker exec -u box -w /home/box "$C" bash -ic 'true' 2>&1 | sed 's/^/  [bash -i stderr] /' || true
wait_running "$C" && echo "daemon BACK" || { echo "FAIL: not back after bash -ic"; exit 1; }
state "$C"
bx "$C" 'grep "\[observer\] started" ~/.provian/observer.log | tail -1'

say "crash (kill), then agent tool-call shell, login: bash -lc 'true'"
kill_daemon "$C"; unthrottle "$C"; state "$C"
docker exec -u box -w /home/box "$C" bash -lc 'true'
wait_running "$C" && echo "daemon BACK" || { echo "FAIL: not back after bash -lc"; exit 1; }
state "$C"

say "crash, then login POSIX sh (dash): sh -lc 'true'"
kill_daemon "$C"; unthrottle "$C"
docker exec -u box -w /home/box "$C" sh -lc 'true'
wait_running "$C" && echo "daemon BACK" || { echo "FAIL: not back after sh -lc"; exit 1; }

say "crash, then plain NON-interactive bash -c 'true' (reads no startup file — NOT covered by the rc hook)"
kill_daemon "$C"; unthrottle "$C"
docker exec -u box -w /home/box "$C" bash -c 'true'
sleep 2
if running "$C"; then echo "daemon running (unexpected)"; else echo "daemon NOT started by bash -c (expected: no rc file is read)"; fi

say "…second trigger: an act verb through the wrapper runs the ensure first (bash -c '~/.provian/bin/provian inbox')"
docker exec -u box -w /home/box "$C" bash -c '"$HOME/.provian/bin/provian" inbox >/dev/null 2>&1 || true'
wait_running "$C" && echo "daemon BACK (via the act verb)" || { echo "FAIL: not back after act verb"; exit 1; }

say "PID REUSE: stale pidfile + lock naming a LIVE unrelated process (what a reboot leaves behind)"
kill_daemon "$C"; unthrottle "$C"
bx "$C" 'nohup sleep 1000 >/dev/null 2>&1 & echo $! > /tmp/stranger; s=$(cat /tmp/stranger); echo $s > ~/.provian/observer.pid; mkdir -p ~/.provian/observer.lock; echo $s > ~/.provian/observer.lock/pid; echo "stranger pid $s: $(tr "\000" " " < /proc/$s/cmdline)"'
docker exec -u box -w /home/box "$C" bash -lc 'true'
wait_running "$C" && echo "daemon BACK despite the reused pid" || { echo "FAIL: pid reuse left the device dark"; state "$C"; exit 1; }
state "$C"
bx "$C" 'echo "lock pid now: $(cat ~/.provian/observer.lock/pid); stranger $(cat /tmp/stranger) still alive: $(kill -0 $(cat /tmp/stranger) && echo yes)"'

say "INSTANCE MOVE: fresh container from the pristine image, only /home/box carried over"
docker cp "$C:/home/box" "$WORK/box"
docker rm -f "$C" >/dev/null
docker run -d --name "$C2" "$IMAGE" sleep infinity >/dev/null
docker exec "$C2" sh -c 'useradd -s /bin/bash box && rm -rf /home/box'
docker cp "$WORK/box" "$C2:/home/box"
docker exec "$C2" sh -c 'chown -R box:box /home/box'
state "$C2"
if running "$C2"; then echo "FAIL: running before a shell"; exit 1; fi
bx "$C2" 'rm -f ~/.provian/restart-hook.stamp'
docker exec -u box -w /home/box "$C2" bash -lc 'true'
wait_running "$C2" && echo "daemon BACK on the moved instance" || { echo "FAIL: dark after instance move"; exit 1; }
state "$C2"
bx "$C2" 'grep "\[observer\] started" ~/.provian/observer.log | tail -1'

say "uninstall removes the hook"
bx "$C2" 'node ~/.provian/agent.js uninstall --yes >/dev/null 2>&1 || true; grep -c provian-restart-hook ~/.bashrc ~/.profile 2>/dev/null || true; ls ~/.provian 2>/dev/null || echo "~/.provian removed"'

docker rm -f "$C2" >/dev/null 2>&1 || true
rm -rf "$WORK"
say "RESTART DRILL PASSED"
